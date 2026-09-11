import { describe, expect, it } from 'vitest';
import { SUPPLIER_COLUMNS, optimisticSupplier } from '@/lib/queries/reference';

/**
 * The column list against the type it claims to be.
 *
 * ===========================================================================
 * Why this file exists, and why nothing else could have caught the bug.
 *
 * Three supplier queries listed their columns by hand, all three omitted
 * `is_placeholder`, and each cast the result `as Supplier[]`. **A cast is an
 * assertion, not a check.** `tsc` agreed, every row arrived with the field
 * `undefined`, and the placeholder feature broke in both directions at once —
 * invisible to a shop and an assistant who needed it, and visible to the four
 * who must never see it, because `!undefined` is `true`.
 *
 * Every existing test passed throughout, and they could not have failed:
 * fixtures and mocks are written against the TYPE, so they all set the field.
 * The only thing that decides which columns actually arrive is the select
 * string, and nothing compared the two. §39.8 — a mock that cannot produce a
 * real state guarantees bugs in it.
 *
 * So this compares them. `optimisticSupplier` is the single definition of a
 * complete Supplier in runtime values (it is already relied on that way by
 * the sheet and the cache), which makes its keys the list the query has to
 * match. Add a column to `Supplier`, and this fails until the query asks for
 * it.
 *
 * It does NOT prove the column exists in the database — nothing running in
 * jsdom can. `db/verify_schema.sql` is that half.
 * ===========================================================================
 */

const selected = SUPPLIER_COLUMNS.split(',').map((column) => column.trim());

describe('the supplier select', () => {
  it('asks for every field a Supplier has', () => {
    const expected = Object.keys(optimisticSupplier('id', 'name')).sort();
    expect([...selected].sort()).toEqual(expected);
  });

  it('asks for is_placeholder by name', () => {
    /*
     * Named explicitly as well as covered by the comparison above, because
     * this is the one whose absence was silent rather than loud. A missing
     * `name` would have emptied every screen in the app within a second; a
     * missing boolean read as `undefined` and every `!` on it flipped.
     */
    expect(selected).toContain('is_placeholder');
  });

  it('is a plain column list, with no join or alias in it', () => {
    // A `*` or an embedded resource would make the comparison above
    // meaningless — it would pass while asking for something else entirely.
    expect(SUPPLIER_COLUMNS).not.toMatch(/[*():]/);
  });

  it('names each column once', () => {
    expect(new Set(selected).size).toBe(selected.length);
  });
});
