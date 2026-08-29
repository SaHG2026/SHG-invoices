'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PIN_LENGTH } from '@/lib/constants';

/**
 * The keypad from spec §7.1.
 *
 * Its own digits rather than a text input, for three reasons that all come
 * from notes §4: the on-screen keyboard would take half the screen and push
 * the pad under itself; `type="number"` brings spinners and changes value on
 * scroll; and a fixed grid of large targets is far more accurate one-handed
 * than a phone keyboard's number row.
 *
 * Every key is 64px, comfortably past the 44px floor.
 *
 * ---------------------------------------------------------------------------
 * Completion fires from the keypress that produces the last digit. It used to
 * fire from an effect watching `entry`, and that was wrong in a way worth
 * recording, because it looked completely reasonable.
 *
 * Setting a PIN asks for it twice: the parent stores the first entry and waits
 * for the second. Storing it re-renders the parent, which gives `onComplete` a
 * new identity, which re-runs any effect that lists it as a dependency — while
 * `entry` is still the six digits just typed. So it fired again, immediately,
 * with the same PIN. The confirmation step compared the PIN against itself,
 * matched, and set it from a single entry. The same fault made every wrong
 * unlock attempt count twice, turning five tries into three.
 *
 * A keypress is a real event that happens exactly once. State-watching effects
 * re-run whenever React feels like it, which is not the same thing.
 * ---------------------------------------------------------------------------
 */

interface PinPadProps {
  /** Fired once, when the PIN_LENGTH-th digit is pressed. */
  onComplete: (pin: string) => void;
  /** Set while the PIN is being checked, to stop a second submission. */
  busy?: boolean;
  /** Bumping this clears the entry — used between the two setup steps. */
  resetToken?: number;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

export function PinPad({ onComplete, busy = false, resetToken = 0 }: PinPadProps) {
  const [entry, setEntry] = useState('');

  // Held in a ref so `press` does not have to be rebuilt when the parent hands
  // down a new callback, and so it always calls the current one.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    setEntry('');
  }, [resetToken]);

  const press = useCallback(
    (key: string) => {
      if (busy) return;

      if (key === '⌫') {
        setEntry((current) => current.slice(0, -1));
        return;
      }
      if (key === '') return;

      setEntry((current) => {
        if (current.length >= PIN_LENGTH) return current;
        return current + key;
      });
    },
    [busy],
  );

  // Fire completion exactly once, when the entry first reaches full length.
  // Guarded by a ref rather than by the effect's dependencies, so a parent
  // re-render cannot replay it.
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (entry.length !== PIN_LENGTH) {
      if (entry.length === 0) firedFor.current = null;
      return;
    }
    if (firedFor.current === entry) return;
    firedFor.current = entry;
    onCompleteRef.current(entry);
  }, [entry]);

  // A physical keyboard should work too — it is the same app on a laptop.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') press('⌫');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [press]);

  return (
    <div>
      <div
        className="mb-8 flex justify-center gap-3"
        role="status"
        aria-label={`${entry.length} of ${PIN_LENGTH} digits entered`}
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className="size-3 rounded-sm border transition-colors duration-150"
            style={{
              borderColor: 'var(--color-slate)',
              backgroundColor: i < entry.length ? 'var(--color-gold)' : 'transparent',
            }}
          />
        ))}
      </div>

      <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-3">
        {KEYS.map((key, i) =>
          key === '' ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              onClick={() => press(key)}
              disabled={busy}
              aria-label={key === '⌫' ? 'Delete' : key}
              className="flex h-16 items-center justify-center rounded-sm border border-slate/40 text-h2 text-snow transition-colors active:bg-slate/30 disabled:opacity-40"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
