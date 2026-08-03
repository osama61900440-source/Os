// firebase-init.js
// ============================================================================
// Load this as: <script type="module" src="firebase-init.js"></script>
// Uses the Firebase v9+ modular SDK straight from the CDN (no build step
// needed — works fine on GitHub Pages).
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// TODO: replace with YOUR project's config (Firebase Console → Project Settings)
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxxxxxxxx"
};

// ---- Primary app: the session that stays logged in for whoever is using
// this device (Super Admin, Shop Owner, or Staff — role is looked up from
// Firestore after auth, see auth-router.js). ----
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

// PERSISTENT LOGIN — Requirement #1: never ask to log in again after the
// first successful sign-in, until the user explicitly logs out.
await setPersistence(auth, browserLocalPersistence);

// ---- Secondary app: an ISOLATED auth session used only when an Owner adds
// a Staff member (staff-add-by-owner.js). Verifying the staff's phone number
// here does NOT touch/replace the Owner's session in `auth` above. ----
export const secondaryApp = initializeApp(firebaseConfig, "StaffOnboardingSecondary");
export const secondaryAuth = getAuth(secondaryApp);
// Secondary app deliberately does NOT get persistence — it's used for a few
// seconds to verify a phone number, then immediately signed out again
// (see staff-add-by-owner.js).
