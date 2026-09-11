'use client';

import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SupplierField } from '@/components/invoice/SupplierField';
import { PersonChip } from '@/components/ui/PersonChip';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { useCurrentProfile, useProfiles } from '@/lib/queries/session';
import { optimisticSupplier, useCreateSupplier, useSuppliers } from '@/lib/queries/reference';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import { useVoidInvoice } from '@/lib/queries/payments';
import {
  useApproveInvoices,
  useAwaitingReview,
  useReassignSupplier,
  useReviewNotes,
  type ReviewRow,
} from '@/lib/queries/review';
import { formatCents, sumCents } from '@/lib/money';
import { formatDateTime, formatDay } from '@/lib/date';
import type { Business, Supplier } from '@/lib/types';

/**
 * What is waiting for one of the four to accept it.
 *
 * The client's reason for the whole feature: *"whenever gmh or gmp adds an
 * invoice, then it has to be approved by one of the managements before it
 * shows in the pending or overdue"*.
 *
 * ---------------------------------------------------------------------------
 * It is no longer only the shops, and the screen needed no code for that.
 *
 * CATCH_UP_026 sends one more thing here: an assistant's invoice filed against
 * "Supplier not listed". Not all of their entries — one naming a real supplier
 * still goes straight into the ledger, which is CATCH_UP_022 §5's decision and
 * it stands. Only the case where the row still has an unanswered question in
 * it, and the answer is in a note that only this screen displays.
 *
 * Everything below already handled it. The queue is `approved_at is null`, not
 * "entered by a venue"; the cards group by business, and an assistant picks a
 * business like anybody else; `blocked` tests `is_placeholder`, which is
 * exactly the condition that put these here. **The only thing that had to
 * change was the words**, because the words said "the shops" and that was no
 * longer true — and a screen that misnames who is asking is a screen somebody
 * makes the wrong decision on.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * Three things about this screen are load-bearing rather than layout.
 *
 * **The note is shown in full, never behind a tap.** Taking supplier creation
 * away from the shops (CATCH_UP_013 §5) makes the note the only channel they
 * have for "this is from somebody new, here is their name" — and a channel
 * nobody reads is not a channel. It is the reason this is a list of cards and
 * not a list of rows.
 *
 * **An invoice on "Supplier not listed" cannot be approved as it stands.**
 * Approving it would file real money against a placeholder, permanently, and
 * nobody would ever go looking for it there. So the supplier picker opens on
 * the card and Approve stays disabled until a real one is chosen.
 *
 * **The total at the top is what is NOT in any other total.** Every figure
 * elsewhere in the app excludes these, by construction (architecture §2, and
 * `useUnpaidInvoices` asks the database for approved rows only). This number
 * exists so that exclusion is visible rather than silent — the failure mode of
 * the whole feature is an invoice entered, never reviewed, and invisible.
 * ---------------------------------------------------------------------------
 */
export function ReviewList() {
  const toast = useToast();
  const today = useSydneyToday();
  const { data: rows = [], isLoading } = useAwaitingReview();
  const { data: people = [] } = useProfiles();
  const { data: suppliers = [] } = useSuppliers();

  const approve = useApproveInvoices();
  const reassign = useReassignSupplier();
  const voidInvoice = useVoidInvoice();
  const createSupplier = useCreateSupplier();
  const { data: profile } = useCurrentProfile();

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const { data: notes = {} } = useReviewNotes(ids);

  const [rejecting, setRejecting] = useState<ReviewRow | null>(null);

  /*
   * Grouped by business, because that is how the work arrives: one shop's
   * morning, then the other's. "Approve all from Parramatta" is the action
   * somebody actually wants, and it is only expressible if the screen knows
   * what a batch is.
   *
   * Called `byBusiness` and not `byVenue` since CATCH_UP_026, because it is no
   * longer only venues that land here — an assistant's placeholder entry
   * groups under whichever business they picked, which may not be a shop at
   * all. The grouping was always `business_id`; only the name was narrower
   * than the thing.
   */
  const byBusiness = useMemo(() => {
    const groups = new Map<string, { business: Business; rows: ReviewRow[] }>();
    for (const row of rows) {
      const existing = groups.get(row.business_id);
      if (existing) existing.rows.push(row);
      else groups.set(row.business_id, { business: row.business as Business, rows: [row] });
    }
    return [...groups.values()].sort((a, b) => a.business.code.localeCompare(b.business.code));
  }, [rows]);

  const blocked = (row: ReviewRow) => row.supplier.is_placeholder;

  async function approveMany(batch: ReviewRow[], label: string) {
    const ready = batch.filter((row) => !blocked(row));
    const held = batch.length - ready.length;

    if (ready.length === 0) {
      toast.show('Choose a supplier first — these are on “Supplier not listed”.', 'problem');
      return;
    }

    try {
      const result = await approve.mutateAsync(ready.map((row) => row.id));
      const missed = result.missed.length;
      toast.show(
        [
          `${label} approved.`,
          missed > 0 ? `${missed} already done by somebody else.` : '',
          held > 0 ? `${held} still need a supplier.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch {
      toast.show('Couldn’t approve that. Nothing changed.', 'problem');
    }
  }

  /*
   * Make the supplier the note names, and move the invoice onto it.
   *
   * ---------------------------------------------------------------------------
   * Two writes, in this order, and the order is a foreign key.
   *
   * `invoices.supplier_id` references `suppliers(id)`, so the supplier has to
   * exist before anything can point at it. Offline they queue in the order
   * they were made, which is the same guarantee the add-invoice sheet has
   * relied on since Phase 7 — supplier first, then the row that references it.
   *
   * `submitWrite` for BOTH, not `mutateAsync`. An offline `mutateAsync` never
   * resolves — the write is paused, not refused — so awaiting one would hang
   * this handler at a dock with no signal, which is exactly where a shop's
   * invoice gets reviewed on a phone.
   *
   * The id is generated here so a replayed write conflicts on the primary key
   * instead of creating a second supplier (notes §1.5).
   * ---------------------------------------------------------------------------
   */
  async function createAndAssign(row: ReviewRow, name: string) {
    if (!profile) return;

    const id = optimisticSupplier(crypto.randomUUID(), name).id;

    const made = await submitWrite(createSupplier, { id, name, actorId: profile.id });
    if (made.kind === 'failed') {
      toast.show(writeFailureMessage(made.error, `Couldn’t add ${name}.`), 'problem');
      return;
    }

    const moved = await submitWrite(reassign, {
      id: row.id,
      supplierId: id,
      supplierName: name,
    });
    if (moved.kind === 'failed') {
      // The supplier exists now, so say so: the half that landed is not lost,
      // and the picker will offer it on the next attempt.
      toast.show(
        writeFailureMessage(moved.error, `Added ${name}, but couldn’t move this invoice onto it.`),
        'problem',
      );
      return;
    }

    toast.show(
      made.kind === 'queued' || moved.kind === 'queued'
        ? `Added ${name} — will send when you’re back online.`
        : `Added ${name} and moved this invoice onto it.`,
    );
  }

  const total = sumCents(rows);

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
      <header className="mb-4">
        <h1 className="text-h1 text-ink">Review</h1>
        <p className="mt-1 text-sm text-muted">
          Entered by the shops, and anything filed on “Supplier not listed”. Nothing here is in
          Pending, Overdue or any total until it is approved.
        </p>
      </header>

      {/*
        Present at zero, saying so. A card that disappears when empty is a card
        nobody notices is missing when it should be there — and the thing it
        would be hiding is somebody's invoice.
      */}
      <section className="mb-6 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Waiting</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(total)}
        </p>
        <p className="mt-1 text-sm text-muted">
          {isLoading
            ? 'Loading…'
            : rows.length === 0
              ? 'Nothing to review.'
              : `${rows.length} invoice${rows.length === 1 ? '' : 's'} across ${
                  byBusiness.length
                } business${byBusiness.length === 1 ? '' : 'es'}`}
        </p>
      </section>

      {byBusiness.map(({ business, rows: batch }) => (
        <section key={business.id} className="mb-6">
          {/*
            The business name is not allowed to truncate.

            It was "GroceryMate Hu…" beside a full-width "Approve all 2" at
            360px — the one thing on the row that has to be read, losing to the
            button. Two changes, and neither is `min-w-0`, which was doing
            exactly what it was told: the button shortened its wording, and the
            heading dropped to body size. It is a group label above a list, not
            the heading of the page — "Review" is that — so display size was
            costing 40px to say something the name already says.
          */}
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="flex min-w-0 flex-1 items-center gap-2 text-base font-medium text-ink">
              <BusinessMark business={business} size="sm" />
              <span className="truncate">{business.name}</span>
            </h2>
            <button
              type="button"
              onClick={() => void approveMany(batch, business.code)}
              disabled={approve.isPending || batch.every(blocked)}
              className="touch shrink-0 whitespace-nowrap rounded-full bg-action px-3 text-sm text-action-text disabled:opacity-40"
            >
              Approve {batch.filter((row) => !blocked(row)).length}
            </button>
          </div>

          <ul className="flex flex-col gap-2">
            {batch.map((row) => (
              <ReviewCard
                key={row.id}
                row={row}
                notes={notes[row.id] ?? []}
                people={people}
                suppliers={suppliers}
                busy={approve.isPending || reassign.isPending}
                onApprove={() => void approveMany([row], row.supplier.name)}
                onReject={() => setRejecting(row)}
                onCreateSupplier={(name) => void createAndAssign(row, name)}
                creating={createSupplier.isPending}
                onPickSupplier={async (supplier) => {
                  try {
                    await reassign.mutateAsync({
                      id: row.id,
                      supplierId: supplier.id,
                      supplierName: supplier.name,
                    });
                    toast.show(`Moved to ${supplier.name}.`);
                  } catch {
                    toast.show('Couldn’t change the supplier.', 'problem');
                  }
                }}
              />
            ))}
          </ul>
        </section>
      ))}

      {!isLoading && rows.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          Nothing needs looking at. New entries from the shops appear here, and so does any invoice
          filed on “Supplier not listed”.
        </p>
      ) : null}

      <ConfirmDialog
        open={rejecting !== null}
        title="Reject this entry?"
        points={[
          <>
            It is voided, with a reason, and kept forever — <strong>{rejecting?.supplier.name}</strong>
            {rejecting ? `, ${formatCents(rejecting.amount_cents)}` : ''}.
          </>,
          <>
            Whoever entered it is not told. It simply stops appearing for them, so tell them, or
            they will enter it again.
          </>,
        ]}
        question="Reject it?"
        confirmLabel="Reject"
        onConfirm={async () => {
          const row = rejecting;
          setRejecting(null);
          if (!row) return;
          try {
            await voidInvoice.mutateAsync({ id: row.id, reason: 'Rejected at review' });
            toast.show('Rejected.');
          } catch {
            toast.show('Couldn’t reject that. Nothing changed.', 'problem');
          }
        }}
        onCancel={() => setRejecting(null)}
      />
    </AppChrome>
  );
}

/* -------------------------------------------------------------------------- */

function ReviewCard({
  row,
  notes,
  people,
  suppliers,
  busy,
  onApprove,
  onReject,
  onPickSupplier,
  onCreateSupplier,
  creating,
}: {
  row: ReviewRow;
  notes: string[];
  people: readonly { id: string; display_name: string; initials: string; accent: string }[];
  suppliers: Supplier[];
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onPickSupplier: (supplier: Supplier) => void;
  /** Make the supplier the note names, and move this invoice onto it. */
  onCreateSupplier: (name: string) => void;
  creating: boolean;
}) {
  const author = people.find((person) => person.id === row.created_by);
  const unlisted = row.supplier.is_placeholder;
  const [picking, setPicking] = useState(false);

  return (
    <li className="rounded-sm border border-edge bg-card p-3">
      <div className="flex items-start gap-3">
        {author ? (
          <PersonChip profile={author as never} />
        ) : (
          <span className="size-6 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {unlisted ? (
              <span style={{ color: 'var(--spine-today)' }}>Supplier not listed</span>
            ) : (
              row.supplier.name
            )}
          </p>
          {/*
            Two short lines, and the invoice's own date is on neither.

            One long line ran off the end at 360px and took the DUE date with
            it, which is the field somebody reviewing is actually checking. Two
            lines fixed that and left "Dated … · entered …" truncating mid-word
            instead — so the invoice date came off the card entirely. It is on
            the full record; what review asks is "is this real, who is it from,
            and when is it out of the account", and the note, the due date and
            the entry time answer all three.
          */}
          <p className="figure-date mt-0.5 truncate text-xs text-muted">
            {row.invoice_number ? `#${row.invoice_number}` : 'No invoice number'}
            {' · due '}
            {formatDay(row.due_date)}
          </p>
          <p className="figure-date mt-0.5 truncate text-xs text-muted">
            Entered {formatDateTime(row.created_at)}
          </p>
        </div>

        <span className="money shrink-0 text-sm text-ink">{formatCents(row.amount_cents)}</span>
      </div>

      {/*
        The note, in full and unprompted. It is the shops' only way to say
        anything at all, and after CATCH_UP_013 it is where the name of a new
        supplier is written down. Behind a tap it would not be read.
      */}
      {notes.length > 0 ? (
        <div
          className="mt-3 rounded-sm px-3 py-2"
          style={{ backgroundColor: 'var(--spine-today-bg)' }}
        >
          {notes.map((note, index) => (
            <p key={index} className="text-sm leading-snug text-ink">
              {note}
            </p>
          ))}
        </div>
      ) : unlisted ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--spine-overdue)' }}>
          Filed under “Supplier not listed” with no note saying who it is from. The shop will know
          — nothing here does.
        </p>
      ) : null}

      {unlisted ? (
        <div className="mt-3">
          {picking ? (
            <SupplierField
              suppliers={suppliers}
              selected={null}
              onSelect={(supplier) => {
                setPicking(false);
                onPickSupplier(supplier);
              }}
              /*
               * Creating from here is on purpose and is the point of the note:
               * if it is genuinely a new supplier, this is where it gets made.
               *
               * -----------------------------------------------------------------
               * That comment was here, above `allowCreate={false}` and an empty
               * `onCreate`. The intent was written down and the negation was
               * wired, and it stayed that way through every round that touched
               * this screen — including two that were specifically about this
               * flow.
               *
               * Reported from a real review: a shop filed against the
               * placeholder with the note "Sokko Pastry", and the manager typing
               * "Sokko" got *No supplier matches that.* and no way forward.
               * Approve stays disabled on a placeholder, so the invoice could
               * not be accepted OR corrected without leaving the screen — and
               * `lib/queries/review.ts` says why that matters: "a correction
               * that requires going somewhere else is a correction that does not
               * get made."
               *
               * A comment describing behaviour is not behaviour. When one says
               * a control exists, check that it does.
               * -----------------------------------------------------------------
               */
              onCreate={onCreateSupplier}
              creating={creating}
            />
          ) : (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="touch w-full rounded-sm border border-action bg-action-bg px-3 text-sm text-action"
            >
              Choose the real supplier
            </button>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || unlisted}
          className="touch flex-1 rounded-full bg-action px-3 text-sm text-action-text disabled:opacity-40"
        >
          {unlisted ? 'Needs a supplier' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          className="touch shrink-0 rounded-full border px-4 text-sm disabled:opacity-40"
          style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
        >
          Reject
        </button>
      </div>
    </li>
  );
}
