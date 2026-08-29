import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllLockState,
  clearPin,
  hasPin,
  isUnlocked,
  isValidPinFormat,
  markUnlocked,
  pinAvailable,
  setPin,
  verifyPin,
} from '@/lib/pin';
import { PIN_MAX_ATTEMPTS } from '@/lib/constants';

/**
 * The device lock, as storage.
 *
 * The bug this file mainly exists for: signing out cleared the PIN from
 * localStorage but left the "already unlocked" flag in sessionStorage. Signing
 * back in then found a stale flag saying this person was already through, and
 * skipped the PIN screen entirely — the app simply stopped locking, quietly,
 * and only for people who had signed out at least once.
 *
 * Two halves of one fact living in two files is how that happened. They are
 * one module now, and `clearAllLockState` is the only thing that clears them.
 */

const MANI = 'p-mani';
const SUJAN = 'p-sujan';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('signing out', () => {
  it('clears the unlocked flag, not just the PIN', async () => {
    await setPin(MANI, '123456');
    markUnlocked(MANI);

    expect(hasPin(MANI)).toBe(true);
    expect(isUnlocked(MANI)).toBe(true);

    clearAllLockState();

    expect(hasPin(MANI)).toBe(false);
    // The one that was missed. If this is true, the next sign-in walks
    // straight past the PIN screen.
    expect(isUnlocked(MANI)).toBe(false);
  });

  it('clears every person on the device, not only the one signing out', async () => {
    await setPin(MANI, '111111');
    await setPin(SUJAN, '222222');
    markUnlocked(MANI);
    markUnlocked(SUJAN);

    clearAllLockState();

    for (const person of [MANI, SUJAN]) {
      expect(hasPin(person)).toBe(false);
      expect(isUnlocked(person)).toBe(false);
    }
  });

  it('leaves unrelated storage alone', async () => {
    localStorage.setItem('shg.business.selected', 'GMH');
    sessionStorage.setItem('something.else', 'keep me');
    await setPin(MANI, '123456');
    markUnlocked(MANI);

    clearAllLockState();

    expect(localStorage.getItem('shg.business.selected')).toBe('GMH');
    expect(sessionStorage.getItem('something.else')).toBe('keep me');
  });
});

describe('unlocked flag', () => {
  it('is per person', () => {
    markUnlocked(MANI);
    expect(isUnlocked(MANI)).toBe(true);
    expect(isUnlocked(SUJAN)).toBe(false);
  });

  it('starts false', () => {
    expect(isUnlocked(MANI)).toBe(false);
  });
});

describe('the PIN itself', () => {
  it('is available in this environment', () => {
    // If this fails the rest of the suite is meaningless rather than passing.
    expect(pinAvailable()).toBe(true);
  });

  it('accepts the right PIN and rejects a wrong one', async () => {
    await setPin(MANI, '123456');

    expect((await verifyPin(MANI, '123456')).ok).toBe(true);
    expect((await verifyPin(MANI, '654321')).ok).toBe(false);
  });

  it('never stores the PIN itself', async () => {
    await setPin(MANI, '123456');
    const raw = localStorage.getItem('shg.pin.' + MANI) ?? '';

    expect(raw).not.toContain('123456');
    expect(raw).toContain('salt');
    expect(raw).toContain('hash');
  });

  it('salts per person, so the same PIN hashes differently', async () => {
    await setPin(MANI, '123456');
    await setPin(SUJAN, '123456');

    const a = JSON.parse(localStorage.getItem('shg.pin.' + MANI)!);
    const b = JSON.parse(localStorage.getItem('shg.pin.' + SUJAN)!);

    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('counts down and wipes the PIN after the last attempt', async () => {
    await setPin(MANI, '123456');

    for (let attempt = 1; attempt < PIN_MAX_ATTEMPTS; attempt++) {
      const result = await verifyPin(MANI, '000000');
      expect(result.ok).toBe(false);
      expect(result.lockedOut).toBe(false);
      expect(result.attemptsLeft).toBe(PIN_MAX_ATTEMPTS - attempt);
    }

    const last = await verifyPin(MANI, '000000');
    expect(last.lockedOut).toBe(true);
    // The PIN is deleted rather than timed out: a timeout is skipped by
    // clearing site data, and the password is what establishes identity.
    expect(hasPin(MANI)).toBe(false);
  });

  it('forgets failed attempts once the right PIN is entered', async () => {
    await setPin(MANI, '123456');

    await verifyPin(MANI, '000000');
    await verifyPin(MANI, '000000');
    expect((await verifyPin(MANI, '123456')).ok).toBe(true);

    // The counter reset, so a later mistake starts from full again.
    expect((await verifyPin(MANI, '000000')).attemptsLeft).toBe(PIN_MAX_ATTEMPTS - 1);
  });

  it('refuses anything that is not six digits', async () => {
    expect(isValidPinFormat('123456')).toBe(true);
    expect(isValidPinFormat('12345')).toBe(false);
    expect(isValidPinFormat('1234567')).toBe(false);
    expect(isValidPinFormat('12345a')).toBe(false);
    expect(isValidPinFormat('')).toBe(false);

    await expect(setPin(MANI, '12345')).rejects.toThrow(/6 digits/);
  });

  it('reports locked out when no PIN is stored', async () => {
    const result = await verifyPin(MANI, '123456');
    expect(result).toEqual({ ok: false, attemptsLeft: 0, lockedOut: true });
  });

  it('clearPin removes one person without touching another', async () => {
    await setPin(MANI, '111111');
    await setPin(SUJAN, '222222');

    clearPin(MANI);

    expect(hasPin(MANI)).toBe(false);
    expect(hasPin(SUJAN)).toBe(true);
  });
});
