import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SupplierField } from '@/components/invoice/SupplierField';
import { SUPPLIERS } from '../fixtures/invoices';
import type { Supplier } from '@/lib/types';

/**
 * What a shop sees when the placeholder row is not in the database.
 *
 * ===========================================================================
 * The failure this is standing over was silent for a year.
 *
 * `includePlaceholder` is true on exactly two sheets — a venue's and an
 * assistant's — and both of those tiers are forbidden from creating a
 * supplier. The row is their only way to file a delivery from somebody new.
 *
 * When it was missing from the data, they got a picker with no way out and
 * nothing anywhere saying why: no error, no empty state, just an absence that
 * reads as the feature never having been built. It was reported that way
 * twice, and both reports were right.
 *
 * Every test in the suite mocked a supplier list that CONTAINED the
 * placeholder, so the state the two tiers were actually in was the one state
 * nothing could reach. §39.8 again, and the third time this shape has cost a
 * round: a mock that cannot produce a real state guarantees bugs in it.
 *
 * So this file renders the list WITHOUT it, on purpose.
 * ===========================================================================
 */

const UNLISTED: Supplier = {
  id: 's-unlisted',
  name: 'Supplier not listed',
  default_terms_days: null,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: true,
  is_placeholder: true,
};

const noop = () => {};

function field(suppliers: Supplier[], props: Partial<Parameters<typeof SupplierField>[0]> = {}) {
  return render(
    <SupplierField
      suppliers={suppliers}
      selected={null}
      onSelect={noop}
      onCreate={noop}
      allowCreate={false}
      includePlaceholder
      {...props}
    />,
  );
}

const browse = () => fireEvent.click(screen.getByRole('button', { name: 'Show all suppliers' }));

describe('the placeholder is missing from the data', () => {
  it('says so, rather than showing a picker with no way out', () => {
    field(SUPPLIERS);
    expect(screen.getByText(/is missing from this list/)).toBeInTheDocument();
  });

  it('tells them what to do in the meantime', () => {
    // They cannot fix it and must not be stopped by it: the invoice still has
    // to be entered, and the note is the channel that survives.
    field(SUPPLIERS);
    expect(screen.getByText(/write who it is really from in the note/)).toBeInTheDocument();
  });

  it('names the fault, so what they report upstream is useful', () => {
    field(SUPPLIERS);
    expect(screen.getByText(/placeholder row needs restoring/)).toBeInTheDocument();
  });

  it('does not block anything — every real supplier is still pickable', () => {
    field(SUPPLIERS);
    browse();
    expect(screen.getByRole('button', { name: /Bidfood/ })).toBeInTheDocument();
  });
});

describe('the placeholder is present', () => {
  it('says nothing at all', () => {
    field([...SUPPLIERS, UNLISTED]);
    expect(screen.queryByText(/is missing from this list/)).not.toBeInTheDocument();
  });

  it('and the row is in the list', () => {
    field([...SUPPLIERS, UNLISTED]);
    browse();
    expect(screen.getByRole('button', { name: /Supplier not listed/ })).toBeInTheDocument();
  });
});

describe('a screen that never wanted the placeholder', () => {
  it('says nothing, even though the row is equally absent', () => {
    /*
     * The four's own sheet passes `includePlaceholder={false}`, and the row
     * being missing is none of its business. A notice here would be the app
     * reporting a fault to the one tier it does not affect.
     */
    field(SUPPLIERS, { includePlaceholder: false, allowCreate: true });
    expect(screen.queryByText(/is missing from this list/)).not.toBeInTheDocument();
  });
});
