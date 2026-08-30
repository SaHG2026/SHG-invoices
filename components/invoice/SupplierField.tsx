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
 */

interface SupplierFieldProps {
  suppliers: Supplier[];
  selected: Supplier | null;
  onSelect: (supplier: Supplier) => void;
  onCreate: (name: string) => void;
  creating?: boolean;
  error?: string;
}

export function SupplierField({
  suppliers,
  selected,
  onSelect,
  onCreate,
  creating = false,
  error,
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
      }),
    [suppliers, query, recentIds, browsing],
  );

  const offerCreate = !browsing && canCreateSupplier(suppliers, query);

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

          {matches.length === 0 && !offerCreate ? (
            <li className="px-3 py-3 text-sm text-muted">
              {browsing
                ? 'No suppliers yet. Type a name to add the first one.'
                : 'No supplier matches that. Keep typing to add a new one.'}
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
