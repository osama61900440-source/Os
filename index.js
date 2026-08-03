// functions/index.js
// ============================================================================
// The two Cloud Functions this flow needs. Everything else (Owner/Staff OTP
// via Phone Auth, Firestore reads/writes for products/sales/batches, the
// Owner's live approval-list listener) happens directly from the client SDK
// under the security rules in ../firestore.rules.
//
// Why these two specific pieces must be server-side (Admin SDK), not client:
//   1. Hashing/comparing a password must never expose the hash to a client
//      that could read it and brute-force it offline — bcrypt hash+compare
//      only ever happens here.
//   2. Minting a Firebase Custom Token requires the Admin SDK's private
//      service-account credentials — the client SDK cannot do this, by
//      design (otherwise anyone could mint a token for any UID).
// ============================================================================
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const bcrypt = require('bcrypt');

admin.initializeApp();
const db = admin.firestore();

// ============================================================================
// Function 1 — createBusinessProfile
// Called right after the Owner's phone OTP is confirmed (owner-registration.js).
// Runs with the Owner already authenticated (context.auth.uid = owner's UID),
// so we don't need them to pass their own UID — we trust context.auth only.
// ============================================================================
exports.createBusinessProfile = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'እባክዎ በስልክ OTP ይግቡ');
  }
  const { fullName, phone, businessName, location, storePassword } = data;
  if (!fullName || !phone || !businessName || !location || !storePassword) {
    throw new functions.https.HttpsError('invalid-argument', 'ሁሉንም መስኮች ይሙሉ');
  }
  if (storePassword.length !== 8) {
    throw new functions.https.HttpsError('invalid-argument', 'የይለፍ ቃል በትክክል 8 አሃዝ መሆን አለበት');
  }

  const ownerUid = context.auth.uid;

  // Guard against double-submission (e.g. form resubmitted after a slow
  // network response) creating two businesses for the same owner.
  const existing = await db.collection('users').doc(ownerUid).get();
  if (existing.exists) {
    throw new functions.https.HttpsError('already-exists', 'ይህ አካውንት አስቀድሞ ተመዝግቧል');
  }

  const storePasswordHash = await bcrypt.hash(storePassword, 10);

  const businessRef = db.collection('businesses').doc(); // random id
  await businessRef.set({
    name: businessName,
    location,
    ownerUid,
    storePasswordHash,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('users').doc(ownerUid).set({
    uid: ownerUid,
    role: 'shop_owner',
    businessId: businessRef.id,
    name: fullName,
    phone,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { businessId: businessRef.id };
});

// ============================================================================
// Function 2 — verifyStoreAndIssueToken  (see detailed comment below)
// ============================================================================

exports.verifyStoreAndIssueToken = functions.https.onCall(async (data, context) => {
  const { phone, businessName, location, storePassword } = data;

  if (!phone || !businessName || !location || !storePassword) {
    throw new functions.https.HttpsError('invalid-argument', 'ሁሉንም መስኮች ይሙሉ');
  }

  // 1) Find the business by name + location (case-insensitive-ish match).
  const bizSnap = await db.collection('businesses')
    .where('name', '==', businessName)
    .where('location', '==', location)
    .limit(1)
    .get();

  if (bizSnap.empty) {
    throw new functions.https.HttpsError('not-found', 'ድርጅቱ አልተገኘም — ስም/ቦታ ያረጋግጡ');
  }
  const business = bizSnap.docs[0];

  // 2) Verify the store password against the bcrypt hash saved at Owner
  //    registration time (owner-registration.js writes this hash).
  const passwordOk = await bcrypt.compare(storePassword, business.data().storePasswordHash);
  if (!passwordOk) {
    throw new functions.https.HttpsError('permission-denied', 'የድርጅቱ የይለፍ ቃል ትክክል አይደለም');
  }

  // 3) Find the staff user doc — must already exist from the Owner-side
  //    step (staff-add-by-owner.js), matched by phone + businessId, and must
  //    still be waiting for this exact step (prevents replay / re-use).
  const staffSnap = await db.collection('users')
    .where('phone', '==', phone)
    .where('businessId', '==', business.id)
    .where('role', '==', 'staff')
    .where('status', '==', 'awaiting_device_registration')
    .limit(1)
    .get();

  if (staffSnap.empty) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'ይህ ስልክ ቁጥር በባለቤቱ አልተመዘገበም ወይም አስቀድሞ ገብቷል'
    );
  }
  const staffDoc = staffSnap.docs[0];

  // 4) Flip status so the Owner's live "pending approvals" list picks this
  //    up immediately (staff-add-by-owner.js's watchPendingStaffApprovals).
  await staffDoc.ref.update({
    status: 'pending_owner_approval',
    deviceRegisteredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 5) Mint the custom token for the staff's ALREADY-CREATED uid (created
  //    back when the Owner verified their phone in staff-add-by-owner.js).
  const customToken = await admin.auth().createCustomToken(staffDoc.id);

  return { token: customToken };
});
