// auth-router.js
// ============================================================================
// Single source of truth for "who is signed in and where should they land".
// Runs once at app startup; also fires automatically whenever auth state
// changes (login, logout, token refresh) thanks to onAuthStateChanged.
// ============================================================================
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import { isPinLockActive, showPinUnlockScreen } from "./pin-lock.js";

let currentUserUnsub = null; // live listener on /users/{uid}, so role/status
                             // changes (e.g. owner approves staff) reflect
                             // instantly without a page reload.

onAuthStateChanged(auth, async (firebaseUser) => {
  showScreen('splash');

  if (!firebaseUser) {
    // Nobody signed in on this device yet → show the registration/login screen.
    if (currentUserUnsub) { currentUserUnsub(); currentUserUnsub = null; }
    showScreen('authScreen');
    return;
  }

  // Requirement #1 (Persistent Login): we ONLY get here once per device —
  // after this, browserLocalPersistence means the user is never asked to
  // log in again, even after closing the app, until they explicitly log out.

  // Requirement (Optional Lock): if the user turned on the Passcode/PIN lock
  // in Settings, show that BEFORE the app content, even though Firebase
  // Auth itself is already silently signed in.
  if (isPinLockActive()) {
    const unlocked = await showPinUnlockScreen();
    if (!unlocked) return; // stays on lock screen until correct PIN
  }

  const userRef = doc(db, 'users', firebaseUser.uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    // Signed in (phone verified) but no role/profile doc yet — this only
    // happens mid-registration (e.g. browser refreshed between OTP success
    // and finishing the business-profile form). Send them back to finish it.
    showScreen('ownerRegistrationStep1');
    return;
  }

  const profile = snap.data();

  // Live-listen so role/status changes reflect immediately (this is how the
  // Staff waiting screen auto-unlocks the instant the Owner taps Approve).
  if (currentUserUnsub) currentUserUnsub();
  currentUserUnsub = onSnapshot(userRef, (liveSnap) => {
    routeByProfile(liveSnap.data(), firebaseUser);
  });

  routeByProfile(profile, firebaseUser);
});

function routeByProfile(profile, firebaseUser) {
  if (!profile) return;

  switch (profile.role) {
    case 'super_admin':
      // Requirement #2: Super Admin is NEVER blocked by anything else —
      // straight into the Super Admin Dashboard.
      showScreen('superAdminDashboard');
      break;

    case 'shop_owner':
      showScreen('mainApp', { role: 'shop_owner', businessId: profile.businessId });
      break;

    case 'staff':
      if (profile.status === 'pending_owner_approval') {
        // Requirement #4 step 4: staff already has a live session (signed in
        // via custom token) but waits here — this listener will fire again
        // automatically the moment the Owner approves, no refresh needed.
        showScreen('staffWaitingApproval');
      } else if (profile.status === 'active') {
        showScreen('mainApp', { role: 'staff', businessId: profile.businessId, permissions: profile.permissions });
      } else if (profile.status === 'suspended') {
        showScreen('staffSuspendedScreen');
      }
      break;

    default:
      showScreen('authScreen');
  }
}

export async function logoutEverywhere() {
  if (currentUserUnsub) { currentUserUnsub(); currentUserUnsub = null; }
  await signOut(auth);
  // onAuthStateChanged fires again automatically -> shows authScreen.
}

// Simple screen-switcher stub — wire this to however your app's page
// containers are shown/hidden (e.g. the `setPage()` pattern already used in
// index.html's dashboard/pos/inventory pages).
function showScreen(name, params) {
  document.dispatchEvent(new CustomEvent('gurage:navigate', { detail: { name, params } }));
}
