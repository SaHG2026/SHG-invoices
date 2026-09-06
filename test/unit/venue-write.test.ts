import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/**
 * A venue's invoice reaches the database.
 *
 * ---------------------------------------------------------------------------
 * The bug this stands over, because it lasted from the day the shops got
 * accounts until somebody tried to use one.
 *
 * `registerVenueMutations` sent `.upsert(payload, { ignoreDuplicates: true })`,
 * for the reason notes §1.5 gives: a write replayed from the offline queue
 * must not create a second invoice. That is right, and on this table for this
 * account it was fatal.
 *
 * PostgREST compiles `.upsert()` to `INSERT ... ON CONFLICT`, which brings the
 * table's UPDATE policies into the permission check. A member passes them via
 * `member_all`. A venue's only update policy is `staff_update`, which requires
 * a row created in the last five minutes — and on an insert there is no such
 * row. So every venue insert came back `42501` for a payload correct in every
 * particular, and the app said "Couldn't save that invoice."
 *
 * Nothing caught it. `verify_staff.mjs` proved the boundary REFUSES what it
 * should, and a missing permission looks identical to a working refusal from
 * the outside — its positive write test sat behind `--write` and was never
 * run. The lesson is in that file now too.
 *
 * These assert the shape of the request, which is the thing that was wrong.
 * ---------------------------------------------------------------------------
 */

const calls = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
  result: { current: { error: null as unknown } },
}));

vi.mock('@/lib/supabase/browser', () => ({
  supabase: () => ({
    from: () => ({
      insert: (payload: unknown) => {
        calls.insert(payload);
        return Promise.resolve(calls.result.current);
      },
      upsert: (payload: unknown, options: unknown) => {
        calls.upsert(payload, options);
        return Promise.resolve(calls.result.current);
      },
    }),
  }),
}));

const { registerVenueMutations } = await import('@/lib/queries/venue');
const { mk } = await import('@/lib/offline/keys');

const payload = {
  id: 'inv-1',
  business_id: 'venue-1',
  supplier_id: 's-1',
  invoice_number: null,
  invoice_date: '2026-09-06',
  due_date: '2026-09-20',
  amount_cents: 1_000,
  created_by: 'gmp',
};

function send() {
  const client = new QueryClient();
  registerVenueMutations(client);
  const fn = client.getMutationDefaults([...mk.venue.create]).mutationFn!;
  // TanStack types the default mutationFn as (vars, context) — the second is
  // its own bookkeeping and this write never reads it.
  return (fn as (vars: unknown) => Promise<unknown>)({ payload, supplierName: 'Bidfood' });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.result.current = { error: null };
});

describe('the request a venue actually sends', () => {
  it('is a plain insert, never an upsert', async () => {
    await send();

    expect(calls.insert).toHaveBeenCalledWith(payload);
    // The whole bug, in one assertion. An upsert here is refused by RLS for
    // this account and the app reports it as an unexplained failure.
    expect(calls.upsert).not.toHaveBeenCalled();
  });

  it('does not ask for the row back', async () => {
    /*
     * A venue has no SELECT policy on `invoices`, and PostgREST answers a
     * select it cannot satisfy with an empty result rather than an error — so
     * `.select()` here would look like it worked and hand back nothing
     * (ARCHITECTURE §34.6). The mock has no `.select`, so calling one throws.
     */
    await expect(send()).resolves.toBeUndefined();
  });
});

describe('a write replayed from the queue', () => {
  it('is success when the primary key already holds this exact row', async () => {
    // What `ignoreDuplicates` used to buy, kept without the upsert. The id was
    // generated on the client before sending precisely so a retry could be
    // recognised — notes §1.5.
    calls.result.current = {
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "invoices_pkey"',
        details: 'Key (id)=(inv-1) already exists.',
      },
    };

    await expect(send()).resolves.toBeUndefined();
  });

  it('is NOT success when some other unique index collided', async () => {
    /*
     * `invoices_internal_ref_unique` is the backstop migration 001 put under
     * the reference generator. A collision there is a real problem and must
     * not be swallowed as "already sent" — that would hide the one failure the
     * index exists to make loud.
     */
    calls.result.current = {
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "invoices_internal_ref_unique"',
        details: 'Key (internal_ref)=(GMP-260906-01) already exists.',
      },
    };

    await expect(send()).rejects.toMatchObject({ code: '23505' });
  });

  it('rethrows a refusal rather than calling it a replay', async () => {
    calls.result.current = {
      error: { code: '42501', message: 'new row violates row-level security policy' },
    };

    await expect(send()).rejects.toMatchObject({ code: '42501' });
  });
});
