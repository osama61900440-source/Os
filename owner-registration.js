// owner-registration.js
// ============================================================================
// Requirement #3: Shop Owner registration — Page 1 (profile form) then
// Page 2 (phone OTP). On success: business doc + user doc (role=shop_owner)
// are created via a Cloud Function (so the store password is bcrypt-hashed
// SERVER-SIDE — never hash secrets client-side, since a client-computed
// hash algorithm must exactly match whatever verifies it later, and rolling
// your own crypto in the browser is easy to get subtly wrong/insecure).
// ============================================================================
import {
  RecaptchaVerifier, signInWithPhoneNumber
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, functions } from "./firebase-init.js";

const createBusinessProfile = httpsCallable(functions, 'createBusinessProfile');

let recaptchaVerifier = null;
let confirmationResult = null;
let pendingProfile = null; // holds Step 1 form data until Step 2 confirms

/**
 * Call this once the Step-1 form's #recaptcha-container-owner element exists
 * in the DOM (e.g. right when ownerRegistrationStep1 screen is shown).
 */
export function initOwnerRecaptcha() {
  if (recaptchaVerifier) return;
  recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container-owner', {
    size: 'invisible',
  });
}

/**
 * Step 1 submit handler.
 * @param {{fullName:string, phone:string, businessName:string, location:string, password:string}} formData
 */
export async function submitOwnerStep1(formData) {
  if (!/^\+?[0-9]{9,15}$/.test(formData.phone.replace(/\s/g, ''))) {
    throw new Error('የስልክ ቁጥር ትክክል አይደለም');
  }
  if (!formData.password || formData.password.length !== 8) {
    throw new Error('የይለፍ ቃል በትክክል 8 አሃዝ መሆን አለበት');
  }

  pendingProfile = { ...formData, phone: normalizePhone(formData.phone) };

  initOwnerRecaptcha();
  confirmationResult = await signInWithPhoneNumber(auth, pendingProfile.phone, recaptchaVerifier);
  // → caller should now show the OTP input screen (Step 2)
  return true;
}

/**
 * Step 2 submit handler — the code the owner received by SMS within ~1 minute.
 */
export async function submitOwnerOtp(code) {
  if (!confirmationResult) throw new Error('እባክዎ መጀመሪያ ደረጃ 1ን ይሙሉ');

  await confirmationResult.confirm(code); // throws if wrong code; signs the owner in persistently

  // Owner is now authenticated (context.auth is populated for the call
  // below) — the Cloud Function hashes the store password with bcrypt and
  // creates both the business and user(role=shop_owner) docs with the
  // Admin SDK, so no insecure client-side hashing and no client Firestore
  // writes are needed for this step.
  await createBusinessProfile({
    fullName: pendingProfile.fullName,
    phone: pendingProfile.phone,
    businessName: pendingProfile.businessName,
    location: pendingProfile.location,
    storePassword: pendingProfile.password,
  });

  pendingProfile = null;
  confirmationResult = null;
  // auth-router.js's onAuthStateChanged listener now takes over and routes
  // to mainApp automatically — nothing else to do here.
}

function normalizePhone(phone) {
  const digits = phone.replace(/\s/g, '');
  return digits.startsWith('+') ? digits : `+251${digits.replace(/^0/, '')}`; // adjust country code as needed
}
