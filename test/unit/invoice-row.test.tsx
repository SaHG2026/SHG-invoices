import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { InvoiceRow } from '@/components/invoice/InvoiceRow';
import { PROFILES, makeInvoice } from '../fixtures/invoices';
import { sydneyToday } from '@/lib/date';

/**
 * How a row shows what has happened to it.
 *
 * Reported from the phone: ticking an invoice appeared to do nothing, so the
 * natural response was to tap again — and several ended up paid. Two causes,
 * both fixed:
 *
 *   the lists other than "unpaid" were never invalidated after a payment
 *   (lib/queries/keys.ts), and
 *
 *   the row vanished rather than saying what had happened, so there was no
 *   confirmation that the right one went. On a list of near-identical
 *   invoices from one supplier, that is exactly when confirmation matters.
 */

const TODAY = sydneyToday();
const MANI = PROFILES.find((p) => p.display_name === 'Mani')!;

function row(overrides: Parameters<typeof makeInvoice>[0] = {}, onMarkPaid?: () => void) {
  return render(
    <ul>
      <InvoiceRow
        invoice={makeInvoice({ created_by: PROFILES[0]!.id, ...overrides })}
        today={TODAY}
        people={PROFILES}
        expanded={false}
        onToggle={vi.fn()}
        {...(onMarkPaid ? { onMarkPaid } : {})}
      />
    </ul>,
  );
}

describe('an unpaid row', () => {
  it('offers a tick and shows the due date', () => {
    row({ status: 'unpaid' }, vi.fn());
    expect(screen.getByRole('button', { name: /^Mark .* paid$/ })).toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  it('is not struck through', () => {
    const { container } = row({ status: 'unpaid' }, vi.fn());
    expect(container.querySelector('.line-through')).toBeNull();
  });
});

describe('a paid row', () => {
  const paid = { status: 'paid' as const, paid_by: MANI.id, paid_at: '2026-09-11T22:30:00.000Z' };

  it('is struck through', () => {
    const { container } = row(paid, vi.fn());
    expect(container.querySelectorAll('.line-through').length).toBeGreaterThan(0);
  });

  it('carries a Paid label', () => {
    row(paid, vi.fn());
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('says who paid it', () => {
    row(paid, vi.fn());
    expect(screen.getByText(/Paid by Mani/)).toBeInTheDocument();
  });

  it('no longer offers a tick', () => {
    // Nothing on a list should be able to pay an invoice twice.
    row(paid, vi.fn());
    expect(screen.queryByRole('button', { name: /^Mark .* paid$/ })).not.toBeInTheDocument();
  });

  it('drops the urgency colour — a paid invoice is not late', () => {
    const { container } = row(
      { ...paid, due_date: '2020-01-01' },
      vi.fn(),
    );
    const spine = container.querySelector('span[aria-hidden]') as HTMLElement;
    expect(spine.style.backgroundColor).toBe('var(--paid)');
    expect(screen.queryByText(/days late/)).not.toBeInTheDocument();
  });
});

describe('a voided row', () => {
  const voided = { status: 'void' as const, void_reason: 'Entered twice' };

  it('is struck through and labelled Void, not Paid', () => {
    const { container } = row(voided, vi.fn());
    expect(screen.getByText('Void')).toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.line-through').length).toBeGreaterThan(0);
  });

  it('offers no tick', () => {
    row(voided, vi.fn());
    expect(screen.queryByRole('button', { name: /^Mark .* paid$/ })).not.toBeInTheDocument();
  });
});

describe('nothing broken — notes §6', () => {
  it('renders every status without undefined or NaN', () => {
    for (const status of ['unpaid', 'paid', 'void'] as const) {
      const { container, unmount } = row({ status, paid_by: MANI.id });
      const text = container.textContent ?? '';
      for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
        expect(text, `${status} row leaked ${token}`).not.toContain(token);
      }
      unmount();
    }
  });

  it('copes with a payer who is no longer an active profile', () => {
    // Somebody deactivated still paid the invoice; the row must not break.
    const { container } = row({ status: 'paid', paid_by: 'p-gone' });
    expect(within(container).getByText('Paid')).toBeInTheDocument();
    expect(container.textContent).not.toContain('undefined');
  });
});
