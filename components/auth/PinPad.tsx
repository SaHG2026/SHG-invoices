'use client';

import { useCallback, useEffect, useState } from 'react';
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
 */

interface PinPadProps {
  /** Fired once PIN_LENGTH digits are entered. */
  onComplete: (pin: string) => void;
  /** Set while the PIN is being checked, to stop a second submission. */
  busy?: boolean;
  /** Bumping this clears the entry — used to reset after a wrong PIN. */
  resetToken?: number;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

export function PinPad({ onComplete, busy = false, resetToken = 0 }: PinPadProps) {
  const [entry, setEntry] = useState('');

  useEffect(() => {
    setEntry('');
  }, [resetToken]);

  useEffect(() => {
    if (entry.length === PIN_LENGTH && !busy) onComplete(entry);
  }, [entry, busy, onComplete]);

  const press = useCallback(
    (key: string) => {
      if (busy) return;
      if (key === '⌫') {
        setEntry((current) => current.slice(0, -1));
        return;
      }
      if (key === '') return;
      setEntry((current) => (current.length >= PIN_LENGTH ? current : current + key));
    },
    [busy],
  );

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
