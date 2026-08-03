// pin-lock.js
// ============================================================================
// Requirement #1 (Optional Lock): a user-chosen Passcode/PIN that blocks the
// SCREEN (not the Firebase session) — e.g. so a child picking up the phone
// can't poke around the shop's data. This is intentionally NOT part of
// Firebase Auth: it's a local UI gate only, checked every time the app
// regains focus, on top of an already-persistent Firebase session.
//
// Storage: the PIN itself is hashed (SHA-256) and kept in localStorage —
// never sent anywhere, never tied to the Firebase account, so it works even
// fully offline and doesn't require a Firestore round-trip to unlock.
// ============================================================================
const PIN_HASH_KEY = 'gurage_pin_hash';
const PIN_ENABLED_KEY = 'gurage_pin_enabled';

export function isPinLockActive() {
  return localStorage.getItem(PIN_ENABLED_KEY) === '1' && !!localStorage.getItem(PIN_HASH_KEY);
}

export async function setPinLock(pin) {
  if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN 4–6 አሃዝ መሆን አለበት');
  const hash = await sha256(pin);
  localStorage.setItem(PIN_HASH_KEY, hash);
  localStorage.setItem(PIN_ENABLED_KEY, '1');
}

export function disablePinLock() {
  localStorage.removeItem(PIN_ENABLED_KEY);
  localStorage.removeItem(PIN_HASH_KEY);
}

async function verifyPin(pin) {
  const hash = await sha256(pin);
  return hash === localStorage.getItem(PIN_HASH_KEY);
}

/**
 * Shows a full-screen PIN entry overlay and resolves `true` once the correct
 * PIN is entered. Resolves immediately with `true` if the lock isn't active.
 * Wire this into your own overlay markup — shown here as a minimal example
 * using a prompt-free custom element for clarity.
 */
export function showPinUnlockScreen() {
  return new Promise((resolve) => {
    if (!isPinLockActive()) return resolve(true);

    const overlay = document.getElementById('pinLockOverlay');
    const input = document.getElementById('pinLockInput');
    const errorEl = document.getElementById('pinLockError');
    overlay.classList.add('show');
    input.value = '';
    errorEl.textContent = '';
    input.focus();

    const onSubmit = async () => {
      const ok = await verifyPin(input.value.trim());
      if (ok) {
        overlay.classList.remove('show');
        input.removeEventListener('keydown', onKeydown);
        document.getElementById('pinLockSubmitBtn').removeEventListener('click', onSubmit);
        resolve(true);
      } else {
        errorEl.textContent = '❌ የተሳሳተ PIN';
        input.value = '';
      }
    };
    const onKeydown = (e) => { if (e.key === 'Enter') onSubmit(); };

    input.addEventListener('keydown', onKeydown);
    document.getElementById('pinLockSubmitBtn').addEventListener('click', onSubmit);
  });
}

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
