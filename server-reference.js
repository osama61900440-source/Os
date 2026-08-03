/**
 * Gurage POS — Backend Reference Implementation (Node.js + Express)
 * ============================================================================
 * This file is DOCUMENTATION / STARTING-POINT CODE, not a drop-in server.
 * It shows how each chat-requested feature maps onto real infrastructure:
 *
 *   - Phone + OTP auth via an SMS gateway (AfroMessage / Geez SMS placeholder)
 *   - Optional email/password (bcrypt) for account recovery
 *   - 30-day trial + subscription expiry enforced by SERVER time (node-cron)
 *   - Admin endpoints (list/suspend users, revenue aggregation)
 *   - Batch Receipts save → inserts history row, then merges qty into Main
 *     Inventory (upsert by product_id → sku → name)
 *
 * To actually run this you'd need: `npm i express pg jsonwebtoken bcrypt
 * node-cron axios dotenv`, a Postgres database using schema.sql, and a real
 * SMS gateway account/API key. None of that exists in this sandbox — this
 * file is meant to be copied into your own server project and filled in.
 * ============================================================================
 */

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const TRIAL_DAYS = 30;
const WARNING_WINDOW_DAYS = 5;

// ---------------------------------------------------------------------------
// SMS GATEWAY — swap this for your real provider (AfroMessage, Geez SMS, etc)
// ---------------------------------------------------------------------------
async function sendSms(phone, body){
  // Example shape only — replace URL/payload with your provider's API.
  return axios.post(process.env.SMS_GATEWAY_URL, {
    to: phone, message: body, sender: 'GuragePOS'
  }, { headers: { Authorization: `Bearer ${process.env.SMS_GATEWAY_KEY}` } });
}

// ---------------------------------------------------------------------------
// AUTH: phone + OTP  (primary), optional email + password (recovery only)
// ---------------------------------------------------------------------------
app.post('/auth/otp/send', async (req, res) => {
  const { phone } = req.body;
  if(!phone || phone.length < 9) return res.status(400).json({ error:'invalid_phone' });

  // Rate limit: max 1 OTP request per phone per 60s (protect SMS cost)
  const recent = await db.query(
    `SELECT id FROM otp_codes WHERE phone=$1 AND created_at > now() - interval '60 seconds'`,
    [phone]
  );
  if(recent.rowCount > 0) return res.status(429).json({ error:'rate_limited' });

  const code = String(Math.floor(1000 + Math.random()*9000));
  const codeHash = await bcrypt.hash(code, 10);
  await db.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2, now() + interval '5 minutes')`,
    [phone, codeHash]
  );
  await sendSms(phone, `Gurage POS ማረጋገጫ ኮድዎ፦ ${code}`);
  res.json({ ok:true });
});

app.post('/auth/otp/verify', async (req, res) => {
  const { phone, code } = req.body;
  const row = await db.query(
    `SELECT * FROM otp_codes WHERE phone=$1 AND consumed=false AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`, [phone]
  );
  if(row.rowCount === 0) return res.status(400).json({ error:'no_active_code' });

  const otp = row.rows[0];
  if(otp.attempt_count >= 5) return res.status(429).json({ error:'too_many_attempts' });

  const valid = await bcrypt.compare(code, otp.code_hash);
  if(!valid){
    await db.query(`UPDATE otp_codes SET attempt_count = attempt_count+1 WHERE id=$1`, [otp.id]);
    return res.status(400).json({ error:'invalid_code' });
  }
  await db.query(`UPDATE otp_codes SET consumed=true WHERE id=$1`, [otp.id]);

  // Find-or-create business, then ensure a subscription (30-day trial) exists.
  let biz = await db.query(`SELECT * FROM businesses WHERE owner_phone=$1`, [phone]);
  if(biz.rowCount === 0){
    biz = await db.query(
      `INSERT INTO businesses (name, owner_phone) VALUES ($1,$2) RETURNING *`,
      [`ንግድ (${phone})`, phone]
    );
    await db.query(
      `INSERT INTO subscriptions (business_id, plan, expires_at)
       VALUES ($1,'trial', now() + interval '${TRIAL_DAYS} days')`,
      [biz.rows[0].id]
    );
  }

  const token = jwt.sign({ businessId: biz.rows[0].id, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn:'30d' });
  res.json({ token, business: biz.rows[0] });
});

// Optional: attach email/password for account recovery (NOT the primary login)
app.post('/auth/email/attach', requireAuth, async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await db.query(`UPDATE businesses SET owner_email=$1, password_hash=$2 WHERE id=$3`,
    [email, hash, req.businessId]);
  res.json({ ok:true });
});

function requireAuth(req, res, next){
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.businessId = payload.businessId;
    next();
  }catch(e){ res.status(401).json({ error:'unauthorized' }); }
}

// ---------------------------------------------------------------------------
// SUBSCRIPTION GATE — every protected route checks server-side expiry.
// This is the piece a static frontend cannot do honestly on its own.
// ---------------------------------------------------------------------------
async function requireActiveSubscription(req, res, next){
  const sub = await db.query(`SELECT * FROM subscriptions WHERE business_id=$1`, [req.businessId]);
  if(sub.rowCount === 0) return res.status(402).json({ error:'no_subscription' });
  const row = sub.rows[0];
  if(row.suspended_by_admin) return res.status(403).json({ error:'suspended_by_admin' });
  if(new Date(row.expires_at) < new Date()){
    return res.status(402).json({ error:'subscription_expired', expiresAt: row.expires_at });
  }
  next();
}

// Example protected route (all inventory/sales/batch endpoints use this gate)
app.get('/api/products', requireAuth, requireActiveSubscription, async (req, res) => {
  const rows = await db.query(`SELECT * FROM products WHERE business_id=$1 ORDER BY name`, [req.businessId]);
  res.json(rows.rows);
});

// ---------------------------------------------------------------------------
// BATCH RECEIPTS — save history row, then merge quantities into Main Inventory
// ---------------------------------------------------------------------------
app.post('/api/batches', requireAuth, requireActiveSubscription, async (req, res) => {
  const { plate, driver, transportCost, loadingCost, items } = req.body;
  const totalQty = items.reduce((a,i)=>a+i.qty, 0);
  const totalExpense = transportCost + loadingCost;
  const perUnitExpense = totalQty > 0 ? totalExpense/totalQty : 0;

  const client = await db.connect();
  try{
    await client.query('BEGIN');

    const batch = await client.query(
      `INSERT INTO batch_receipts (business_id, plate_number, driver_name, transport_cost, loading_cost, total_qty)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.businessId, plate, driver, transportCost, loadingCost, totalQty]
    );
    const batchId = batch.rows[0].id;

    for(const it of items){
      const landedCost = it.cost + perUnitExpense;

      // Match priority: product_id (from autocomplete) → sku → name
      let product = null;
      if(it.pid){
        const r = await client.query(`SELECT * FROM products WHERE id=$1 AND business_id=$2`, [it.pid, req.businessId]);
        product = r.rows[0];
      }
      if(!product && it.sku){
        const r = await client.query(`SELECT * FROM products WHERE business_id=$1 AND sku=$2`, [req.businessId, it.sku]);
        product = r.rows[0];
      }
      if(!product){
        const r = await client.query(`SELECT * FROM products WHERE business_id=$1 AND lower(name)=lower($2)`, [req.businessId, it.name]);
        product = r.rows[0];
      }

      if(product){
        await client.query(
          `UPDATE products SET stock_qty = stock_qty + $1, cost_price=$2, sell_price=$3, updated_at=now() WHERE id=$4`,
          [it.qty, landedCost, it.price, product.id]
        );
      } else {
        const r = await client.query(
          `INSERT INTO products (business_id, name, sku, category, cost_price, sell_price, stock_qty)
           VALUES ($1,$2,$3,'አዲስ ጭነት',$4,$5,$6) RETURNING id`,
          [req.businessId, it.name, it.sku||null, landedCost, it.price, it.qty]
        );
        product = { id: r.rows[0].id };
      }

      await client.query(
        `INSERT INTO batch_items (batch_id, product_id, name, sku, supplier_name, qty, purchase_price, landed_cost, sell_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [batchId, product.id, it.name, it.sku||null, it.supplier||null, it.qty, it.cost, landedCost, it.price]
      );
    }

    await client.query('COMMIT');
    res.json({ ok:true, batchId });
  }catch(e){
    await client.query('ROLLBACK');
    res.status(500).json({ error:'batch_save_failed', detail: e.message });
  }finally{
    client.release();
  }
});

// ---------------------------------------------------------------------------
// ADMIN DASHBOARD — restrict with a real admin-role check, not shown here
// ---------------------------------------------------------------------------
app.get('/admin/users', requireAdmin, async (req, res) => {
  const rows = await db.query(`
    SELECT b.id, b.name, b.owner_phone, b.city,
           s.plan, s.status, s.expires_at, s.suspended_by_admin,
           (SELECT max(last_seen_at) FROM sessions WHERE business_id=b.id) AS last_login
    FROM businesses b
    LEFT JOIN subscriptions s ON s.business_id = b.id
    ORDER BY b.created_at DESC
  `);
  res.json(rows.rows);
});

app.post('/admin/users/:id/suspend', requireAdmin, async (req, res) => {
  await db.query(`UPDATE subscriptions SET suspended_by_admin = NOT suspended_by_admin WHERE business_id=$1`, [req.params.id]);
  res.json({ ok:true });
});

app.get('/admin/revenue', requireAdmin, async (req, res) => {
  const rows = await db.query(`
    SELECT date_trunc('month', approved_at) AS month, sum(amount) AS total
    FROM payments WHERE status='approved'
    GROUP BY 1 ORDER BY 1
  `);
  res.json(rows.rows);
});

function requireAdmin(req, res, next){
  // Replace with real role check (e.g. a separate `admins` table + its own login).
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error:'forbidden' });
  next();
}

// ---------------------------------------------------------------------------
// CRON JOB — runs server-side once a day. This is what actually enforces the
// 30-day limit; the frontend banner/lock screen is just a *reflection* of
// what this job has already decided.
// ---------------------------------------------------------------------------
cron.schedule('0 2 * * *', async () => {  // every day at 02:00 server time
  // 1) Warn businesses with 5 days or fewer left (once per day max)
  const warnList = await db.query(`
    SELECT s.*, b.owner_phone FROM subscriptions s
    JOIN businesses b ON b.id = s.business_id
    WHERE s.expires_at BETWEEN now() AND now() + interval '${WARNING_WINDOW_DAYS} days'
      AND (s.warned_at IS NULL OR s.warned_at < now() - interval '1 day')
      AND s.status = 'active'
  `);
  for(const row of warnList.rows){
    const daysLeft = Math.ceil((new Date(row.expires_at) - new Date()) / 86400000);
    await sendSms(row.owner_phone, `Gurage POS፦ የአገልግሎት ጊዜዎ በ${daysLeft} ቀን ውስጥ ያልቃል። ላለማቋረጥ ይክፈሉ።`);
    await db.query(`UPDATE subscriptions SET status='expiring', warned_at=now() WHERE id=$1`, [row.id]);
  }

  // 2) Lock anything past expiry (data stays intact — only `status` changes)
  const lockList = await db.query(`
    SELECT s.*, b.owner_phone FROM subscriptions s
    JOIN businesses b ON b.id = s.business_id
    WHERE s.expires_at < now() AND s.status <> 'locked'
  `);
  for(const row of lockList.rows){
    await db.query(`UPDATE subscriptions SET status='locked', locked_at=now() WHERE id=$1`, [row.id]);
    await sendSms(row.owner_phone, `Gurage POS፦ የአገልግሎት ጊዜዎ አልቋል። መረጃዎ አልጠፋም — ለመቀጠል ይክፈሉ።`);
  }
});

// When a payment is approved (webhook from Chapa/Telebirr, or admin manual-approve):
async function approvePayment(paymentId){
  const p = await db.query(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
  await db.query(`UPDATE payments SET status='approved', approved_at=now() WHERE id=$1`, [paymentId]);
  await db.query(`
    UPDATE subscriptions SET status='active', expires_at = GREATEST(expires_at, now()) + interval '30 days'
    WHERE business_id=$1
  `, [p.rows[0].business_id]);
}

module.exports = app;
