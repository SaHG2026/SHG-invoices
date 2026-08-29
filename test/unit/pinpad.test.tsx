import { describe, expect, it, vi } from 'vitest';
import { useCallback, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PinPad } from '@/components/auth/PinPad';

/**
 * The bug this file exists to prevent.
 *
 * Setting a PIN asks for it twice. The parent holds the first entry, bumps a
 * reset token to clear the pad, and waits for the second. That means the
 * parent's `onComplete` is a NEW function on the next render — and if
 * completion is driven by an effect keyed on that callback, the effect re-runs
 * while `entry` is still the six digits just typed, and fires a second time.
 *
 * The visible symptom is that the confirmation step never happens: the PIN is
 * accepted from a single entry, having silently "confirmed" itself against
 * itself. The same fault double-counts failed attempts on the unlock screen,
 * so five tries become three.
 *
 * The fix is to fire completion from the keypress that produces the sixth
 * digit, not from an effect watching state. These tests hold that shut.
 */

function type(digits: string) {
  for (const digit of digits) {
    fireEvent.click(screen.getByRole('button', { name: digit }));
  }
}

/** Mirrors exactly what SetPinScreen does: capture, clear, ask again. */
function TwoStepHarness({ onCall }: { onCall: (pin: string) => void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const onComplete = useCallback(
    (pin: string) => {
      onCall(pin);
      if (first === null) {
        setFirst(pin);
        setResetToken((n) => n + 1);
      }
    },
    // `first` changing is what gives onComplete a new identity — the trigger.
    [first, onCall],
  );

  return (
    <div>
      <span data-testid="step">{first === null ? 'first' : 'confirm'}</span>
      <PinPad onComplete={onComplete} resetToken={resetToken} />
    </div>
  );
}

describe('PinPad', () => {
  it('fires once per six digits, even when the parent swaps the callback', () => {
    const onCall = vi.fn();
    render(<TwoStepHarness onCall={onCall} />);

    type('123456');

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall).toHaveBeenCalledWith('123456');
  });

  it('actually reaches the confirmation step instead of self-confirming', () => {
    const onCall = vi.fn();
    render(<TwoStepHarness onCall={onCall} />);

    type('123456');

    // If completion fired twice, the second call would have compared the PIN
    // against itself, matched, and finished setup without ever asking again.
    expect(screen.getByTestId('step')).toHaveTextContent('confirm');
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('accepts a different second entry, so a mismatch can be detected', () => {
    const onCall = vi.fn();
    render(<TwoStepHarness onCall={onCall} />);

    type('123456');
    type('654321');

    expect(onCall).toHaveBeenCalledTimes(2);
    expect(onCall).toHaveBeenNthCalledWith(1, '123456');
    expect(onCall).toHaveBeenNthCalledWith(2, '654321');
  });

  it('clears the pad when the reset token changes', () => {
    const onCall = vi.fn();
    render(<TwoStepHarness onCall={onCall} />);

    type('123456');
    // Reset happened; the next three digits are a fresh entry, not digits 7-9.
    type('999');

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      '3 of 6 digits entered',
    );
  });

  it('ignores a seventh digit', () => {
    const onCall = vi.fn();
    render(<PinPad onComplete={onCall} />);

    type('1234567');

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall).toHaveBeenCalledWith('123456');
  });

  it('deletes with the backspace key', () => {
    const onCall = vi.fn();
    render(<PinPad onComplete={onCall} />);

    type('12345');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '4 of 6 digits entered');

    type('56');
    expect(onCall).toHaveBeenCalledWith('123456');
  });

  it('does nothing while busy', () => {
    const onCall = vi.fn();
    render(<PinPad onComplete={onCall} busy />);

    type('123456');

    expect(onCall).not.toHaveBeenCalled();
  });

  it('gives every key a target of at least 44px — notes §4', () => {
    render(<PinPad onComplete={vi.fn()} />);
    // h-16 is 64px. The class is the contract; jsdom has no layout.
    for (const digit of '0123456789') {
      expect(screen.getByRole('button', { name: digit }).className).toContain('h-16');
    }
  });
});
