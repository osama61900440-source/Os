-- ============================================================================
-- Gurage POS — Backend Database Schema (PostgreSQL)
-- ----------------------------------------------------------------------------
-- This is a REFERENCE schema for the features requested in chat:
--   1) Phone+OTP auth (+ optional email/password)
--   2) 30-day trial / subscription expiry, enforced by SERVER time (not phone clock)
--   3) Admin dashboard (users, logins, city, payment status, revenue)
--   4) Automation: cron jobs read `subscriptions` to warn/lock/send SMS
--   5) Batch Receipts (immutable logistics history) + Main Inventory (live stock)
--
-- Deploy this on any managed Postgres (Supabase, Neon, RDS, etc). A static
-- site (GitHub Pages) CANNOT run this — you need a real server/API in front
-- of it (see server-reference.js in this same folder).
-- ============================================================================

-- Businesses can have many branches, many staff, one subscription.
CREATE TABLE businesses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  owner_phone     TEXT NOT NULL UNIQUE,
  owner_email     TEXT,                         -- optional, for account recovery only
  password_hash   TEXT,                         -- optional (bcrypt), only if email/password set
  city            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- e.g. "አዲስ አበባ ቅርንጫፍ"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- AUTH: phone+OTP is primary. Table only stores short-lived hashed codes.
-- ----------------------------------------------------------------------------
CREATE TABLE otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT NOT NULL,
  code_hash     TEXT NOT NULL,                  -- never store the raw code
  expires_at    TIMESTAMPTZ NOT NULL,            -- e.g. now() + interval '5 minutes'
  consumed      BOOLEAN NOT NULL DEFAULT false,
  attempt_count SMALLINT NOT NULL DEFAULT 0,     -- rate-limit brute force
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_phone ON otp_codes(phone, expires_at);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  jwt_id        TEXT NOT NULL,                   -- jti claim, so tokens can be revoked
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  city          TEXT,                            -- best-effort, from IP geolocation at login
  user_agent    TEXT
);

-- ----------------------------------------------------------------------------
-- SUBSCRIPTION: the ONLY source of truth for trial/lock logic. All expiry
-- checks in the app must read `expires_at` computed here — server time only.
-- ----------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  plan              TEXT NOT NULL DEFAULT 'trial',   -- 'trial' | 'basic' | 'standard' | 'pro'
  status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'expiring' | 'locked' | 'suspended'
  trial_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,             -- trial_started_at + interval '30 days'
  warned_at         TIMESTAMPTZ,                       -- last time a "5 days left" SMS was sent
  locked_at         TIMESTAMPTZ,
  suspended_by_admin BOOLEAN NOT NULL DEFAULT false,   -- manual admin suspend (independent of expiry)
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_expiry ON subscriptions(expires_at) WHERE status <> 'locked';

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2) NOT NULL,
  method          TEXT NOT NULL,                 -- 'chapa' | 'telebirr_api' | 'manual_bank' | 'manual_telebirr'
  reference       TEXT,                          -- transaction reference (manual) or gateway tx id (auto)
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  approved_by     UUID,                          -- admin user id, if manually approved
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at     TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- SMS / notification log (so cron jobs don't double-send)
-- ----------------------------------------------------------------------------
CREATE TABLE sms_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID REFERENCES businesses(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  kind          TEXT NOT NULL,                   -- 'otp' | 'trial_warning' | 'locked' | 'payment_receipt'
  body          TEXT NOT NULL,
  provider_id   TEXT,                            -- gateway's message id, for delivery tracking
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- MAIN INVENTORY (live stock) — quantities merged in from batch receipts
-- ----------------------------------------------------------------------------
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id     UUID REFERENCES branches(id),
  name          TEXT NOT NULL,
  sku           TEXT,                            -- Product Code / barcode, unique per business
  category      TEXT,
  cost_price    NUMERIC(12,2) NOT NULL DEFAULT 0, -- latest landed cost
  sell_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_qty     NUMERIC(12,2) NOT NULL DEFAULT 0,
  photo_url     TEXT,                            -- null = no placeholder shown in UI
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, sku)
);
CREATE INDEX idx_products_search ON products USING gin (to_tsvector('simple', name || ' ' || coalesce(sku,'')));

-- ----------------------------------------------------------------------------
-- BATCH RECEIPTS (immutable logistics history) — never overwritten by stock
-- merges; edits only correct price/sku/supplier, quantity stays as received.
-- ----------------------------------------------------------------------------
CREATE TABLE batch_receipts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id           UUID REFERENCES branches(id),
  plate_number        TEXT NOT NULL,
  driver_name         TEXT NOT NULL,
  transport_cost      NUMERIC(12,2) NOT NULL DEFAULT 0,
  loading_cost        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_expense       NUMERIC(12,2) GENERATED ALWAYS AS (transport_cost + loading_cost) STORED,
  total_qty           NUMERIC(12,2) NOT NULL,
  per_unit_expense    NUMERIC(12,4) GENERATED ALWAYS AS (
                        CASE WHEN total_qty > 0 THEN (transport_cost + loading_cost) / total_qty ELSE 0 END
                      ) STORED,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server timestamp, not device clock
  edited_at           TIMESTAMPTZ,
  created_by          UUID
);

CREATE TABLE batch_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES batch_receipts(id) ON DELETE CASCADE,
  product_id        UUID REFERENCES products(id),   -- set when matched via autocomplete/SKU
  name              TEXT NOT NULL,
  sku               TEXT,
  supplier_name     TEXT,
  qty               NUMERIC(12,2) NOT NULL,
  purchase_price    NUMERIC(12,2) NOT NULL,          -- price paid per unit before overhead
  landed_cost       NUMERIC(12,2) NOT NULL,          -- purchase_price + per_unit_expense (frozen at save time)
  sell_price        NUMERIC(12,2) NOT NULL
);

-- ----------------------------------------------------------------------------
-- Employees / Sales / Expenses / Debts — same shape as the frontend demo
-- ----------------------------------------------------------------------------
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT, role TEXT, monthly_salary NUMERIC(12,2) DEFAULT 0
);

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id),
  employee_id UUID REFERENCES employees(id),
  total NUMERIC(12,2) NOT NULL,
  payment_method TEXT NOT NULL,           -- 'cash' | 'telebirr' | 'bank' | 'credit'
  sold_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  qty NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, method TEXT,
  spent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE debts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid', due_date DATE
);
