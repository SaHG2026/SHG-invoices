import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import TokenSpecimen from '@/app/(app)/specimen/page';
import { formatCents } from '@/lib/money';
import { formatDateTime, formatDay } from '@/lib/date';
import { makeInvoices } from '../fixtures/invoices';

/**
 * The crude test that keeps catching real bugs.
 *
 * Notes §6: "Render every screen with realistic data and assert the output
 * contains no `undefined`, `NaN`, or `[object Object]`. This is crude and it
 * caught real bugs repeatedly in the previous project."
 *
 * It is crude because it does not know what correct looks like. It is valuable
 * because those three strings are what a missing field, a float gone wrong, or
 * an object stringified by accident actually look like on a phone — and
 * because it costs one line per screen. Every screen added in later phases
 * gets added to SCREENS below.
 */

const SCREENS: ReadonlyArray<[string, () => React.ReactElement]> = [
  ['Phase 1 token specimen', () => <TokenSpecimen />],
];

const FORBIDDEN = ['undefined', 'NaN', '[object Object]', 'Invalid Date', 'null'];

describe('every screen, against 200 realistic invoices', () => {
  for (const [name, Screen] of SCREENS) {
    it(`${name} renders nothing broken`, () => {
      const { container } = render(Screen());
      const text = container.textContent ?? '';

      expect(text.length).toBeGreaterThan(100);

      for (const token of FORBIDDEN) {
        expect(text, `"${token}" leaked into ${name}`).not.toContain(token);
      }
    });

    it(`${name} leaves no broken attribute values`, () => {
      const { container } = render(Screen());
      // A NaN width or an undefined colour renders as an attribute, not as
      // text, so the textContent check above would miss it.
      const html = container.innerHTML;
      for (const token of ['NaN', 'undefined', '[object Object]']) {
        expect(html, `"${token}" leaked into an attribute in ${name}`).not.toContain(token);
      }
    });
  }
});

describe('the formatters never emit the forbidden strings', () => {
  it('formatCents survives everything the app can hand it', () => {
    for (const cents of [0, 1, -1, 999_999_999, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = formatCents(cents);
      expect(out).not.toContain('NaN');
      expect(out).not.toContain('undefined');
      expect(out).not.toContain('∞');
    }
  });

  it('formatDay and formatDateTime survive every fixture row', () => {
    for (const row of makeInvoices(200)) {
      for (const out of [formatDay(row.due_date), formatDay(row.invoice_date)]) {
        expect(out).not.toMatch(/undefined|NaN|Invalid/);
      }
      expect(formatDateTime(row.created_at)).not.toMatch(/undefined|NaN|Invalid/);
    }
  });
});
