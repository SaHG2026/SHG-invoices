'use client';

import { useMemo, useRef, useState } from 'react';
import { canCreateSupplier, rankSuppliers } from '@/lib/derive/supplier-match';
import { readRecentSupplierIds } from '@/lib/recents';
import type { Supplier } from '@/lib/types';

/**
 * The supplier type-ahead. Spec §7.3.
 *
 * ---------------------------------------------------------------------------
 * It does NOT autofocus, and that is a reversal.
 *
 * It used to, to save a tap against the fifteen-second target. The cost turned
 * out to be larger than the tap: the keyboard opened while the sheet was still
 * sliding in, the viewport resized underneath it, and the sheet re-animated its
 * own height mid-entrance. The client reported it twice — "springs with so much
 * force and then bounces a couple times" — and both reports were right.
 *
 * Two animations racing is not a tuning problem, it is one animation too many.
 * The sheet now opens as a single movement and the keyboard arrives when
 * somebody asks for it. That is also the only behaviour that is the same on
 * both platforms: Android resizes the layout viewport for a keyboard and iOS
 * draws it on top, so "open the keyboard during the entrance" means two
 * different things and neither of them is calm.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * The list does NOT open on focus.
 *
 * It used to, and it read as clutter: the sheet opened with a menu already
 * hanging under the first field, before anyone had expressed any intent. Now
 * it appears when you type, which is when you have.
 *
 * The chevron is the other way in — for when you want to browse rather than
 * search, one-handed, without typing anything. Two intentions, two gestures,
 * neither of them the default.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * Browsing no longer hides the way to add.
 *
 * `offerCreate` used to carry `&& !browsing`, which made the Add control
 * unreachable along the one path somebody takes when they most need it: open
 * the list, scroll it, find that the supplier genuinely is not there. That is
 * the moment you want to add one, and it was the moment the control was gone —
 * so the field looked, correctly, like it had no way to add a supplier.
 *
 * §24.7 is the same failure on the customers screen, reported twice: **a
 * control that is absent along the path somebody actually walks is absent.**
 * Being present along a different path is not a defence.
 *
 * So browsing is no longer part of the question. With something typed, the
 * ordinary Add row appears under the browse list; with nothing typed there is
 * nothing to name, so a row says so and puts the cursor back in the field.
 * ---------------------------------------------------------------------------
 */

interface SupplierFieldProps {
  suppliers: Supplier[];
  selected: Supplier | null;
  onSelect: (supplier: Supplier) => void;
  onCreate: (name: string) => void;
  creating?: boolean;
  error?: string;
  /**
   * Whether `+ Add "bid" as a new supplier` is offered at all.
   *
   * False for a venue, where the database refuses the insert (CATCH_UP_013 §5
   * drops `staff_insert` on suppliers). The field is not the enforcement — the
   * dropped policy is — but offering a control that would come back `42501` is
   * the interface promising what it cannot do, which ARCHITECTURE §34.6 names
   * as the reason the venue sheet has no business picker either.
   */
  allowCreate?: boolean;
  /** Offer "Supplier not listed". Only ever true on the venue sheet. */
  includePlaceholder?: boolean;
  /** Shown under the field when creating is not on offer. */
  hint?: React.ReactNode;
}

export function SupplierField({
  suppliers,
  selected,
  onSelect,
  onCreate,
  creating = false,
  error,
  allowCreate = true,
  includePlaceholder = false,
  hint,
}: SupplierFieldProps) {
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Read once per mount: a device preference, not live data.
  const recentIds = useMemo(() => readRecentSupplierIds(), []);

  const listOpen = browsing || (typing && query.trim() !== '');

  const matches = useMemo(
    () =>
      rankSuppliers(suppliers, browsing ? '' : query, {
        recentIds,
        // Browsing shows everything, scrollable. Searching shows the best few.
        limit: browsing ? suppliers.length : 5,
        includePlaceholder,
      }),
    [suppliers, query, recentIds, browsing, includePlaceholder],
  );

  const offerCreate = allowCreate && canCreateSupplier(suppliers, query);

  /*
   * Browsing with nothing typed: there is no name to offer, so the row says
   * what to do instead of vanishing. It is not disabled — it puts the cursor
   * in the field, which is the whole of what it is asking for.
   */
  const offerTypeToAdd = allowCreate && browsing && !offerCreate;

  /*
   * The placeholder was asked for and is not in the list.
   *
   * -------------------------------------------------------------------------
   * This exists because its absence was silent for a year.
   *
   * `includePlaceholder` is true on exactly the two sheets whose only way to
   * file an unknown delivery is that row — a shop, and an assistant. Neither
   * may create a supplier. So if the row is missing from the data, those two
   * tiers get a picker with no way out of it and NOTHING anywhere says why:
   * no error, no empty state, just an absence that reads as the feature never
   * having been built. It was reported exactly that way, twice.
   *
   * The row went missing in the database (CATCH_UP_028 has the two ways that
   * happens, and the wipe is still one of them). The app cannot fix that and
   * should not try. What it can do is stop failing silently — an interface
   * that cannot offer what it was told to offer should say so, which is the
   * other half of notes §6.
   * -------------------------------------------------------------------------
   */
  const placeholderMissing =
    includePlaceholder && !suppliers.some((supplier) => supplier.active && supplier.is_placeholder);

  function choose(supplier: Supplier) {
    onSelect(supplier);
    setQuery(supplier.name);
    setTyping(false);
    setBrowsing(false);
    inputRef.current?.blur();
  }

  function close() {
    setTyping(false);
    setBrowsing(false);
  }

  return (
    <div className="mb-4">
      <label className="mb-1 block text-xs uppercase tracking-widest text-muted" htmlFor="supplier">
        Supplier
      </label>

      <div
        className={`flex items-center rounded-sm border bg-card ${error ? 'border-overdue' : 'border-hairline'}`}
      >
        <input
          id="supplier"
          ref={inputRef}
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          placeholder="Start typing"
          value={typing || browsing ? query : (selected?.name ?? query)}
          onChange={(event) => {
            setQuery(event.target.value);
            setTyping(true);
            setBrowsing(false);
          }}
          className="touch min-w-0 flex-1 bg-transparent px-3 text-base text-ink outline-none"
        />

        <button
          type="button"
          aria-label={browsing ? 'Hide supplier list' : 'Show all suppliers'}
          aria-expanded={browsing}
          onClick={() => {
            setBrowsing((current) => !current);
            setTyping(false);
          }}
          className="touch flex shrink-0 items-center justify-center px-3 text-muted"
        >
          <span aria-hidden className="text-base">
            {browsing ? '⌃' : '⌄'}
          </span>
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-1 text-sm text-overdue">
          {error}
        </p>
      ) : null}

      {hint && !error ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}

      {/*
        Not styled as an error, because the person reading it has done nothing
        wrong and cannot act on it either. It tells them the one thing that
        keeps the invoice moving — write it in the note — and names the fault
        so the message they send upstream is useful rather than "it's broken".
      */}
      {placeholderMissing && !error ? (
        <p className="mt-1 text-xs text-muted">
          <span className="text-ink">“Supplier not listed” is missing from this list.</span> Pick
          the closest supplier and write who it is really from in the note, then tell head office
          the placeholder row needs restoring.
        </p>
      ) : null}

      {listOpen ? (
        <ul className="mt-1 max-h-[40dvh] overflow-y-auto overscroll-contain border border-hairline bg-card">
          {matches.map((supplier) => (
            <li key={supplier.id} className="border-b border-hairline last:border-b-0">
              <button
                type="button"
                // onMouseDown, not onClick: the input blurs first on a click and
                // the list would unmount before the click ever lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(supplier);
                }}
                className="touch flex w-full items-center justify-between px-3 text-left text-base text-ink active:bg-pressed"
              >
                <span className="truncate">{supplier.name}</span>
                {supplier.default_terms_days !== null ? (
                  <span className="ml-3 shrink-0 text-xs text-muted">
                    {supplier.default_terms_days} days
                  </span>
                ) : null}
              </button>
            </li>
          ))}

          {matches.length === 0 && !offerCreate && !offerTypeToAdd ? (
            <li className="px-3 py-3 text-sm text-muted">
              {!allowCreate
                ? 'No supplier matches that.'
                : 'No supplier matches that. Keep typing to add a new one.'}
            </li>
          ) : null}

          {offerTypeToAdd ? (
            <li className="border-t border-hairline">
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setBrowsing(false);
                  setTyping(true);
                  inputRef.current?.focus();
                }}
                className="touch flex w-full items-center px-3 text-left text-base text-action active:bg-pressed"
              >
                {matches.length === 0
                  ? 'No suppliers yet — type a name to add the first one'
                  : 'Not on the list? Type a name to add it'}
              </button>
            </li>
          ) : null}

          {offerCreate ? (
            <li className="border-t border-hairline">
              <button
                type="button"
                disabled={creating}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onCreate(query.trim());
                  close();
                }}
                className="touch flex w-full items-center px-3 text-left text-base text-action active:bg-pressed disabled:opacity-50"
              >
                {creating ? 'Adding…' : `Add “${query.trim()}” as a new supplier`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
