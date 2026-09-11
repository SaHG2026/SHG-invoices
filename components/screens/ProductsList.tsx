'use client';

import { useMemo, useRef, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useCurrentProfile } from '@/lib/queries/session';
import { useBusinesses } from '@/lib/queries/reference';
import { useAllProducts, useCreateProduct, useUpdateProduct } from '@/lib/queries/products';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import { centsToInputValue, formatCents, parseAmountToCents } from '@/lib/money';
import type { Product } from '@/lib/types';

/**
 * Deli's price list. The thing an invoice is built from.
 *
 * The client's flow: *"we add list of products (will be added with prices,
 * also an option to add/edit those)"*. So this is list, add, edit the price,
 * and remove — the shape `/suppliers` has, on a table with fewer fields.
 *
 * ---------------------------------------------------------------------------
 * Editing happens on the row, not on a page of its own.
 *
 * A supplier has terms, a contact, a phone and a history worth a screen. A
 * product has a name, a unit and a price. Sending somebody to another page to
 * change one number, and back, and again for the next one, is the wrong shape
 * for the job actually being done here — which is going down a list after a
 * price rise.
 * ---------------------------------------------------------------------------
 *
 * A price changed here changes what the NEXT invoice suggests and nothing that
 * has already been issued: every line copies its price at the moment of issue
 * (CATCH_UP_015 §2). That is the property that makes editing safe.
 */
export function ProductsList({ businessCode = 'DDL' }: { businessCode?: string }) {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();

  const business = businesses.find(
    (entry) => entry.code.toLowerCase() === businessCode.toLowerCase(),
  );
  const { data: products = [], isLoading } = useAllProducts(business?.id ?? null);
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();

  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Product | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? products.filter((product) => product.name.toLowerCase().includes(needle))
      : products;

    const byName = (a: Product, b: Product) => a.name.localeCompare(b.name);
    // Removed ones last: they are history, not choices. Same as suppliers.
    return [
      ...matched.filter((product) => product.active).sort(byName),
      ...matched.filter((product) => !product.active).sort(byName),
    ];
  }, [products, query]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || !business) return;

    const name = newName.trim();
    // Zero allowed: a product can genuinely be free, and a blank price is
    // filled in on the line when the invoice is composed.
    const cents = parseAmountToCents(newPrice, { allowZero: true });
    if (name === '') return;
    if (cents === null && newPrice.trim() !== '') {
      toast.show('That price doesn’t look right. Use digits, like 4.50', 'problem');
      return;
    }

    const outcome = await submitWrite(createProduct, {
      id: crypto.randomUUID(),
      business_id: business.id,
      name,
      unit: newUnit.trim() || null,
      // A product with no price yet is legitimate — it is filled in on the
      // line when the invoice is composed. Blocking here would put a decision
      // in the way of getting the list in.
      unit_price_cents: cents ?? 0,
      created_by: profile.id,
    });

    if (outcome.kind === 'failed') {
      toast.show(writeFailureMessage(outcome.error, 'Couldn’t add that product.'), 'problem');
      return;
    }

    setNewName('');
    setNewUnit('');
    setNewPrice('');
    toast.show(outcome.kind === 'queued' ? `Added ${name} — will send when you’re back online.` : `Added ${name}.`);
  }

  /* The `+` reaches the add row at the top. See `addHere` in AppChrome. */
  const addFieldRef = useRef<HTMLInputElement>(null);

  /* Focus only — it scrolls and opens the keyboard as one movement. The
     Suppliers screen has the full note. */
  function focusAddField() {
    addFieldRef.current?.focus();
  }

  async function save(product: Product, changes: Partial<Product>) {
    try {
      await updateProduct.mutateAsync({ id: product.id, ...changes });
      setEditingId(null);
      toast.show('Saved.');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Couldn’t save that.', 'problem');
    }
  }

  return (
    <AppChrome
      back={{ href: '/customers' as Route, label: 'Customers' }}
      addHere={{ label: 'New product', onPress: focusAddField }}
    >
      <h1 className="text-h1 mb-1 text-ink">Products</h1>
      <p className="mb-3 text-sm text-muted">
        {business ? `${business.name}. ` : ''}Prices here are what a new invoice suggests. Changing
        one never changes an invoice already issued.
      </p>

      <form onSubmit={add} className="mb-4 rounded-sm border border-edge bg-card p-3">
        <div className="mb-2 flex gap-2">
          <input
            ref={addFieldRef}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Product"
            aria-label="New product name"
            autoCapitalize="words"
            className="touch min-w-0 flex-[2] rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
          <input
            value={newUnit}
            onChange={(event) => setNewUnit(event.target.value)}
            placeholder="kg"
            aria-label="Unit"
            className="touch min-w-0 flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card">
            <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
              $
            </span>
            <input
              value={newPrice}
              onChange={(event) => setNewPrice(event.target.value)}
              placeholder="0.00"
              aria-label="Unit price"
              inputMode="decimal"
              className="money touch w-full bg-transparent px-2 text-base text-ink outline-none"
              style={{ textAlign: 'left' }}
            />
          </div>
          <button
            type="submit"
            disabled={newName.trim() === '' || createProduct.isPending || !business}
            className="touch shrink-0 rounded-full bg-action px-5 text-sm text-action-text disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </form>

      <div className="mb-3 flex items-center rounded-sm border border-hairline bg-card">
        <span aria-hidden className="pl-3 text-sm text-muted">
          &#9906;
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a product"
          aria-label="Search products"
          className="touch min-w-0 flex-1 bg-transparent px-2 text-base text-ink outline-none"
        />
      </div>

      {!business ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          No such business.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          {query ? `No product matches “${query}”.` : 'No products yet. Add the first one above.'}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {visible.map((product) => (
            <li key={product.id} className="border-b border-hairline last:border-b-0">
              {editingId === product.id ? (
                <ProductForm
                  product={product}
                  busy={updateProduct.isPending}
                  onCancel={() => setEditingId(null)}
                  onSave={(changes) => void save(product, changes)}
                />
              ) : (
                <div className={`flex h-row items-center gap-3 px-3 ${product.active ? '' : 'opacity-55'}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{product.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {product.unit ? `per ${product.unit}` : 'no unit'}
                      {product.active ? '' : ' · removed'}
                    </span>
                  </span>
                  <span className="money shrink-0 text-sm text-ink">
                    {formatCents(product.unit_price_cents)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingId(product.id)}
                    className="touch shrink-0 px-2 text-sm text-action"
                  >
                    Edit
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editingId ? (
        <button
          type="button"
          onClick={() => {
            const product = products.find((entry) => entry.id === editingId);
            if (product?.active) setRemoving(product);
            else if (product) void save(product, { active: true });
          }}
          className="touch mt-3 w-full rounded-sm border border-hairline bg-card text-sm text-muted"
        >
          {products.find((entry) => entry.id === editingId)?.active
            ? 'Remove this product'
            : 'Restore this product'}
        </button>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ''}?`}
        points={[
          <>It stops appearing when anybody builds an invoice.</>,
          <>
            Every invoice it has ever been on keeps its own copy of the name and the price, so
            nothing already issued changes. Nothing is deleted, and you can put it back from here.
          </>,
        ]}
        question="Remove it?"
        confirmLabel="Remove product"
        onConfirm={() => {
          const product = removing;
          setRemoving(null);
          if (product) void save(product, { active: false });
        }}
        onCancel={() => setRemoving(null)}
      />
    </AppChrome>
  );
}

function ProductForm({
  product,
  busy,
  onSave,
  onCancel,
}: {
  product: Product;
  busy: boolean;
  onSave: (changes: Partial<Product>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [unit, setUnit] = useState(product.unit ?? '');
  const [price, setPrice] = useState(centsToInputValue(product.unit_price_cents));

  const field =
    'touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <form
      className="p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const cents = parseAmountToCents(price, { allowZero: true });
        onSave({
          name: name.trim(),
          unit: unit.trim() || null,
          // A price that will not parse is left alone rather than zeroed —
          // silently writing 0 for "12.o0" would put a free line on the next
          // invoice and nothing on screen would say why.
          ...(cents === null ? {} : { unit_price_cents: cents }),
        });
      }}
    >
      <div className="mb-2 flex gap-2">
        <input
          aria-label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={`${field} flex-[2]`}
          required
        />
        <input
          aria-label="Unit"
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
          placeholder="kg"
          className={`${field} flex-1`}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card">
          <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
            $
          </span>
          <input
            aria-label="Unit price"
            value={price}
            inputMode="decimal"
            onChange={(event) => setPrice(event.target.value)}
            className="money touch w-full bg-transparent px-2 text-base text-ink outline-none"
            style={{ textAlign: 'left' }}
          />
        </div>
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="touch shrink-0 rounded-full bg-action px-4 text-sm text-action-text disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="touch shrink-0 rounded-sm border border-hairline px-3 text-sm text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
