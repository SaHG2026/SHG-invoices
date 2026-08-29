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
 * Selecting fills the field with the supplier's name and closes the list.
 * Typing again reopens it, so correcting a mis-tap costs one character rather
 * than a clear-and-restart.
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
  const [listOpen, setListOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Read once per mount: this is a device preference, not live data, and
  // re-reading on every keystroke would be pointless work.
  const recentIds = useMemo(() => readRecentSupplierIds(), []);

  const matches = useMemo(
    () => rankSuppliers(suppliers, query, { recentIds }),
    [suppliers, query, recentIds],
  );
  const offerCreate = canCreateSupplier(suppliers, query);

  const value = listOpen ? query : (selected?.name ?? query);

  function choose(supplier: Supplier) {
    onSelect(supplier);
    setQuery(supplier.name);
    setListOpen(false);
    inputRef.current?.blur();
  }

  return (
    <div className="mb-5">
      <label className="mb-1 block text-xs uppercase tracking-widest text-mute" htmlFor="supplier">
        Supplier
      </label>

      <input
        id="supplier"
        ref={inputRef}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        // The sheet opens from a tap, so this is inside a user gesture and the
        // keyboard actually appears. See the note above.
        autoFocus
        placeholder="Start typing"
        value={value}
        onChange={(event) => {
          setQuery(event.target.value);
          setListOpen(true);
        }}
        onFocus={() => setListOpen(true)}
        className={`touch w-full rounded-sm border bg-card px-3 text-base text-ink outline-none focus:border-slate ${
          error ? 'border-brick' : 'border-hair'
        }`}
      />

      {error ? (
        <p role="alert" className="mt-1 text-sm text-brick">
          {error}
        </p>
      ) : null}

      {listOpen ? (
        <ul className="mt-1 border border-hair bg-card">
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
              No supplier matches that. Keep typing to add a new one.
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
                  setListOpen(false);
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
