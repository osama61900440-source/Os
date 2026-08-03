// staff-device-registration.js
// ============================================================================
// Requirement #4 — Step ለ (Staff Side Registration), on the STAFF's own phone.
//
// No OTP here — the Owner already verified this phone number in Step ሀ.
// Instead, the "shared secret" proving this person really is that business's
// staff is the Store Password the Owner set at registration. We can't check
// that secret safely in the browser (Firestore rules would have to expose
// the hash to read, inviting offline brute force) — so a small Cloud
// Function does the check server-side and, if correct, returns a Firebase
// Custom Token for the staff's already-created UID. The client then calls
// signInWithCustomToken(), which establishes a normal persistent session on
// THIS device — exactly like the requirement asked for ("ቀጥል ሲል ሁለተኛውን
// የOTP ገጽ ዘሎ ቀጥታ ያልፋል").
// ============================================================================
import { signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, functions } from "./firebase-init.js";

const verifyStoreAndIssueToken = httpsCallable(functions, 'verifyStoreAndIssueToken');

/**
 * @param {{fullName:string, phone:string, businessName:string, location:string, storePassword:string}} formData
 */
export async function submitStaffDeviceRegistration(formData) {
  const { data } = await verifyStoreAndIssueToken({
    phone: normalizePhone(formData.phone),
    businessName: formData.businessName,
    location: formData.location,
    storePassword: formData.storePassword,
  });
  // data = { token } on success; the callable throws (HttpsError) on any
  // mismatch — surface that error message directly to the form.

  await signInWithCustomToken(auth, data.token);
  // auth-router.js's onAuthStateChanged fires now. Because the staff doc's
  // status is still 'awaiting_device_registration' -> the Cloud Function
  // will have already flipped it to 'pending_owner_approval' as part of
  // issuing the token (see functions/index.js) -> router shows the waiting
  // screen below automatically.
}

/**
 * Optional: a dedicated waiting-screen listener if you want more control
 * than the generic one already in auth-router.js (e.g. a countdown or a
 * "notify owner again" button). Both listen to the same document, so
 * either approach works — this one is just for a custom waiting UI.
 */
export function watchOwnApprovalStatus(uid, onStatusChange) {
  return onSnapshot(doc(db, 'users', uid), (snap) => {
    onStatusChange(snap.data()?.status);
  });
}

function normalizePhone(phone) {
  const digits = phone.replace(/\s/g, '');
  return digits.startsWith('+') ? digits : `+251${digits.replace(/^0/, '')}`;
}
