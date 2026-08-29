import { PIN_LENGTH, PIN_MAX_ATTEMPTS } from './constants';

/**
 * The six-digit quick unlock.
 *
 * Spec §2 is explicit: "The PIN unlocks a session, it is not the security
 * boundary." That is worth restating rather than quietly relying on, because
 * it decides what this file is allowed to be:
 *
 *   - The PIN is stored on the device, hashed, and never sent anywhere.
 *   - It gates the interface. It does not protect the data — RLS does.
 *   - Somebody holding an unlocked phone with the session cookie still on it
 *     can reach the data without knowing the PIN. See ARCHITECTURE §8.
 *
 * So this is a lock on a door inside a building you have already been let
 * into. It is worth having — it stops a phone left on a counter being used by
 * the next person to pick it up — and it is not worth pretending it is more.
 *
 * Hashing is PBKDF2-SHA256 with a per-device random salt. Against someone
 * with the device that is not much: six digits is a million combinations and
 * they can try them all offline. The iteration count makes that cost hours
 * rather than seconds, which is the honest limit of what a PIN can do.
 */

const STORE_PREFIX = 'shg.pin.';
const ATTEMPT_PREFIX = 'shg.pin.attempts.';
const ITERATIONS = 150_000;

interface StoredPin {
  salt: string; // base64
  hash: string; // base64
  iterations: number;
  createdAt: string;
}

interface AttemptRecord {
  failed: number;
}

/**
 * Whether this browser can hash a PIN at all.
 *
 * `crypto.subtle` exists only in a secure context — https, or localhost. Over
 * a plain http:// address on the local network it is undefined. Rather than
 * silently falling back to a weak hash, the app skips the PIN entirely in
 * that case and says so on screen. A lock that quietly became a worse lock is
 * worse than no lock, because you would still trust it.
 */
export function pinAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.crypto !== 'undefined' &&
    typeof window.crypto.subtle !== 'undefined'
  );
}

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private browsing, cleared site data, storage disabled. Behaving as if no
    // PIN is set is correct: the person falls back to email and password.
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* nothing sensible to do; the PIN simply will not persist */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Has this person set a PIN on this device? */
export function hasPin(profileId: string): boolean {
  return read<StoredPin>(STORE_PREFIX + profileId) !== null;
}

export async function setPin(profileId: string, pin: string): Promise<void> {
  if (!isValidPinFormat(pin)) {
    throw new Error(`The PIN must be ${PIN_LENGTH} digits.`);
  }
  if (!pinAvailable()) {
    throw new Error('This browser cannot store a PIN securely.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);

  write(STORE_PREFIX + profileId, {
    salt: toBase64(salt),
    hash,
    iterations: ITERATIONS,
    createdAt: new Date().toISOString(),
  } satisfies StoredPin);

  remove(ATTEMPT_PREFIX + profileId);
}

export interface PinCheck {
  ok: boolean;
  /** Tries left before the PIN is cleared and full sign-in is required. */
  attemptsLeft: number;
  /** The PIN has been cleared; this person must sign in with a password. */
  lockedOut: boolean;
}

/**
 * Check a PIN.
 *
 * After PIN_MAX_ATTEMPTS failures the stored PIN is deleted, which forces a
 * full email-and-password sign-in. Deleting rather than timing out, because a
 * timeout is trivially skipped by clearing site data — and because the
 * password is the thing that actually establishes who somebody is.
 */
export async function verifyPin(profileId: string, pin: string): Promise<PinCheck> {
  const stored = read<StoredPin>(STORE_PREFIX + profileId);
  if (!stored || !pinAvailable()) {
    return { ok: false, attemptsLeft: 0, lockedOut: true };
  }

  const attempts = read<AttemptRecord>(ATTEMPT_PREFIX + profileId) ?? { failed: 0 };
  const candidate = await derive(pin, fromBase64(stored.salt), stored.iterations);

  if (candidate === stored.hash) {
    remove(ATTEMPT_PREFIX + profileId);
    return { ok: true, attemptsLeft: PIN_MAX_ATTEMPTS, lockedOut: false };
  }

  const failed = attempts.failed + 1;

  if (failed >= PIN_MAX_ATTEMPTS) {
    clearPin(profileId);
    return { ok: false, attemptsLeft: 0, lockedOut: true };
  }

  write(ATTEMPT_PREFIX + profileId, { failed } satisfies AttemptRecord);
  return { ok: false, attemptsLeft: PIN_MAX_ATTEMPTS - failed, lockedOut: false };
}

export function clearPin(profileId: string): void {
  remove(STORE_PREFIX + profileId);
  remove(ATTEMPT_PREFIX + profileId);
}

/**
 * Wipe every PIN on this device. Called on explicit sign-out: once the session
 * is gone the PIN unlocks nothing, and leaving it behind would be a stale
 * secret sitting in storage for no reason.
 */
export function clearAllPins(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(STORE_PREFIX) || key.startsWith(ATTEMPT_PREFIX))) keys.push(key);
    }
    for (const key of keys) remove(key);
  } catch {
    /* ignore */
  }
}
