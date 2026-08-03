// staff-add-by-owner.js
// ============================================================================
// Requirement #4 — Step ሀ (Owner Side Registration).
//
// KEY DESIGN POINT: we verify the STAFF's phone number using `secondaryAuth`
// (a fully separate Firebase Auth instance — see firebase-init.js), never
// the Owner's own `auth` instance. This means:
//   - The Owner's persistent session is completely undisturbed throughout.
//   - Firebase permanently creates the staff phone number as a real Auth
//     user (with a UID) the moment the Owner enters the correct code —
//     exactly like any other Phone Auth verification, just on the "side".
//   - We immediately sign the secondary instance back out (we only needed
//     the UID + verified-phone proof, not an active session there).
// ============================================================================
import {
  RecaptchaVerifier, signInWithPhoneNumber, signOut as secondarySignOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, secondaryAuth, db } from "./firebase-init.js";

let recaptchaVerifier = null;
let confirmationResult = null;
let pendingStaff = null; // { fullName, phone, role, permissions }

export function initStaffRecaptcha() {
  if (recaptchaVerifier) return;
  // Bound to secondaryAuth explicitly — separate reCAPTCHA widget too.
  recaptchaVerifier = new RecaptchaVerifier(secondaryAuth, 'recaptcha-container-staff', {
    size: 'invisible',
  });
}

/**
 * Owner fills: staff full name, staff phone, role/permissions → clicks
 * "መዝግብ" → this sends the OTP to the STAFF's phone (owner reads it off the
 * staff's screen, or the staff reads it aloud to the owner).
 */
export async function ownerAddStaffStep1({ fullName, phone, role, permissions }) {
  pendingStaff = { fullName, phone: normalizePhone(phone), role, permissions };

  initStaffRecaptcha();
  confirmationResult = await signInWithPhoneNumber(secondaryAuth, pendingStaff.phone, recaptchaVerifier);
  return true; // → show the OTP input to the Owner now
}

/**
 * Owner types in the code that arrived on the staff member's phone.
 */
export async function ownerAddStaffVerifyOtp(code) {
  if (!confirmationResult) throw new Error('እባክዎ መጀመሪያ ደረጃ 1ን ይሙሉ');

  const cred = await confirmationResult.confirm(code); // creates/loads the staff's real Auth account
  const staffUid = cred.user.uid;

  const ownerUid = auth.currentUser.uid; // the OWNER's primary session — untouched this whole time
  const ownerUserSnap = await getOwnerBusinessId(ownerUid);

  // Create the staff's Firestore profile — status starts as
  // 'pending_owner_side_verified'. The staff hasn't done THEIR half yet
  // (device-side registration with the store password), so we don't
  // activate them yet.
  await setDoc(doc(db, 'users', staffUid), {
    uid: staffUid,
    role: 'staff',
    businessId: ownerUserSnap.businessId,
    name: pendingStaff.fullName,
    phone: pendingStaff.phone,
    permissions: pendingStaff.permissions || [],
    status: 'awaiting_device_registration',
    addedBy: ownerUid,
    createdAt: serverTimestamp(),
  });

  // IMPORTANT: sign the secondary instance back out immediately. We only
  // needed the verification + UID, not a lingering session there.
  await secondarySignOut(secondaryAuth);

  pendingStaff = null;
  confirmationResult = null;
  return staffUid;
}

async function getOwnerBusinessId(ownerUid) {
  const { getDoc, doc: docRef } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const snap = await getDoc(docRef(db, 'users', ownerUid));
  return snap.data();
}

function normalizePhone(phone) {
  const digits = phone.replace(/\s/g, '');
  return digits.startsWith('+') ? digits : `+251${digits.replace(/^0/, '')}`;
}

// ----------------------------------------------------------------------------
// Requirement #4 — Step ለ.4/5: Owner's live notification list + Approve button.
// The Cloud Function (functions/index.js) flips status to
// 'pending_owner_approval' once the staff finishes their device-side form —
// this listener shows those to the Owner in real time (e.g. a badge/list in
// Settings), and the Approve button flips status to 'active'.
// ----------------------------------------------------------------------------
import { collection, query, where, onSnapshot as onSnap2, updateDoc, serverTimestamp as ts2 } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export function watchPendingStaffApprovals(businessId, onList) {
  const q = query(
    collection(db, 'users'),
    where('businessId', '==', businessId),
    where('role', '==', 'staff'),
    where('status', '==', 'pending_owner_approval')
  );
  return onSnap2(q, (snap) => {
    onList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function approveStaff(staffUid) {
  await updateDoc(doc(db, 'users', staffUid), {
    status: 'active',
    updatedAt: ts2(),
  });
  // The staff device's own onSnapshot listener (auth-router.js) picks this
  // up instantly and moves them from the waiting screen into the main app —
  // no refresh, no re-login, fully matching Requirement #1 (Persistent Login).
}
