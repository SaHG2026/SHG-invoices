'use client';

import { useMemo, useRef, useState } from 'react';
import { canCreateSupplier, rankSuppliers } from '@/lib/derive/supplier-match';
import { readRecentSupplierIds } from '@/lib/recents';
import type { Supplier } from '@/lib/types';

/**
 * The supplier type-ahead. Spec §7.3.
 *
 * The field autofocuses when the sheet opens, but only because the tap that
 * opened the sheet is a real user gesture — notes §4: "iOS suppresses
 * programmatic keyboard opening outside a user gesture." Focusing later, from
 * an effect that runs after data loads, silently does nothing on a phone.
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
      <label className="mb-1 block text-xs uppercase tracking-widest text-mute" htmlFor="supplier">
        Supplier
      </label>

      <div
        className={`flex items-center rounded-sm border bg-card ${error ? 'border-brick' : 'border-hair'}`}
      >
        <input
          id="supplier"
          ref={inputRef}
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          autoFocus
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
          className="touch flex shrink-0 items-center justify-center px-3 text-mute"
        >
          <span aria-hidden className="text-base">
            {browsing ? '⌃' : '⌄'}
          </span>
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-1 text-sm text-brick">
          {error}
        </p>
      ) : null}

      {listOpen ? (
        <ul className="mt-1 max-h-[40dvh] overflow-y-auto overscroll-contain border border-hair bg-card">
          {matches.map((supplier) => (
            <li key={supplier.id} className="border-b border-hair last:border-b-0">
              <button
                type="button"
                // onMouseDown, not onClick: the input blurs first on a click and
                // the list would unmount before the click ever lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(supplier);
                }}
                className="touch flex w-full items-center justify-between px-3 text-left text-base text-ink active:bg-snow"
              >
                <span className="truncate">{supplier.name}</span>
                {supplier.default_terms_days !== null ? (
                  <span className="ml-3 shrink-0 text-xs text-mute">
                    {supplier.default_terms_days} days
                  </span>
                ) : null}
              </button>
            </li>
          ))}

          {matches.length === 0 && !offerCreate ? (
            <li className="px-3 py-3 text-sm text-mute">
              {browsing
                ? 'No suppliers yet. Type a name to add the first one.'
                : 'No supplier matches that. Keep typing to add a new one.'}
            </li>
          ) : null}

          {offerCreate ? (
            <li className="border-t border-hair">
              <button
                type="button"
                disabled={creating}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onCreate(query.trim());
                  close();
                }}
                className="touch flex w-full items-center px-3 text-left text-base text-slate active:bg-snow disabled:opacity-50"
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
