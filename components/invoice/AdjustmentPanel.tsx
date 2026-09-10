'use client';

import { useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { PersonChip } from '@/components/ui/PersonChip';
import { useCurrentProfile, useProfiles } from '@/lib/queries/session';
import { useAddSalesAdjustment, useVoidSalesAdjustment } from '@/lib/queries/sales';
import { describeAdjustment, liveAdjustments, netCents } from '@/lib/derive/adjustments';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { formatDateTime } from '@/lib/date';
import { isFullMember, isOwner } from '@/lib/staff';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import type { SalesInvoiceAdjustment, SalesInvoiceRow } from '@/lib/types';

/**
 * Discounts and refunds on one of Deli's invoices. ARCHITECTURE §53, J5.
 *
 * ===========================================================================
 * Under the document, not among its buttons.
 *
 * Download, Share and Print are all "get this to somebody". This is "change
 * what this is worth", and putting a fourth pill beside them would make the
 * one destructive-ish control on the screen look like a way of sending it.
 *
 * It sits directly beneath the total block it affects, which is §46.1's
 * lesson: a control belongs with the thing it edits. Round F put Edit outside
 * the panel it edited and the two stopped looking related.
 * ===========================================================================
 *
 * `no-print` throughout. The adjustments are already ON the paper, in the
 * total block, with their reasons — this panel is the machinery for changing
 * them and has no business on a customer's invoice.
 */
export function AdjustmentPanel({ invoice }: { invoice: SalesInvoiceRow }) {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: people = [] } = useProfiles();
  const add = useAddSalesAdjustment();
  const undo = useVoidSalesAdjustment();

  const [applying, setApplying] = useState(false);
  const [undoing, setUndoing] = useState<SalesInvoiceAdjustment | null>(null);

  const live = liveAdjustments(invoice);
  const remaining = netCents(invoice);

  /*
   * Manager and above. CATCH_UP_023 §3 refuses anybody else with 42501, and
   * this is what stops a shop being shown a control that would come back
   * refused (notes §6).
   *
   * Deliberately NOT `isOwner`. §44.6 draws the line and it is worth keeping
   * straight: marking an invoice received records that money moved and is the
   * owner's alone; a discount changes what is owed, before anybody has paid
   * anything, and that is a commercial decision the people running the shop
   * are there to make.
   */
  const mayAdjust = isFullMember(profile);

  if (!mayAdjust && live.length === 0) return null;

  /*
   * A voided invoice can hold no more adjustments, and the database says so
   * too. Offering the control on one would be a button whose entire job is to
   * come back with "that invoice is voided".
   */
  const open = invoice.status !== 'void';

  return (
    <section className="no-print mt-4 rounded-sm border border-edge bg-card p-4">
      <p className="mb-1 text-xs uppercase tracking-widest text-muted">Discounts and refunds</p>

      {live.length === 0 ? (
        <p className="mb-3 text-sm text-muted">
          Nothing has come off this invoice. Anything you take off prints on it, with the reason.
        </p>
      ) : (
        <ul className="mb-3">
          {live.map((adjustment) => {
            const who = people.find((person) => person.id === adjustment.created_by);
            return (
              <li
                key={adjustment.id}
                className="flex items-center gap-3 border-b border-hairline py-2 last:border-b-0"
              >
                {who ? <PersonChip profile={who} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {describeAdjustment(adjustment)} · {formatCents(adjustment.amount_cents)}
                  </span>
                  {/*
                    The reason, and who. Both, always.

                    §44.6: this is the first thing a manager may do that
                    changes a figure the owner watches, so an unexplained $40
                    is exactly the disagreement §28.3 refused `amount_cents`
                    to avoid. The name is not an accusation — it is the thing
                    that makes the figure answerable.
                  */}
                  <span className="block truncate text-xs text-muted">
                    {adjustment.reason} · {who?.display_name ?? 'someone'} ·{' '}
                    {formatDateTime(adjustment.created_at)}
                  </span>
                </span>

                {mayAdjust ? (
                  <button
                    type="button"
                    onClick={() => setUndoing(adjustment)}
                    disabled={undo.isPending}
                    aria-label={`Undo ${describeAdjustment(adjustment).toLowerCase()} of ${formatCents(adjustment.amount_cents)}`}
                    className="touch shrink-0 rounded-full border border-hairline bg-card px-3 text-sm text-action disabled:opacity-40"
                  >
                    Undo
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {mayAdjust && open ? (
        <button
          type="button"
          onClick={() => setApplying(true)}
          className="touch w-full rounded-full border border-hairline bg-card px-4 text-base text-action"
        >
          Take something off…
        </button>
      ) : null}

      {/* Said once, under the control, rather than inside the sheet where it
          would arrive after somebody has decided. */}
      {mayAdjust && open ? (
        <p className="mt-2 text-xs text-muted">
          {formatCents(remaining)} of {formatCents(invoice.amount_cents)} is still owed.
        </p>
      ) : null}

      <ApplySheet
        open={applying}
        invoice={invoice}
        remaining={remaining}
        pending={add.isPending}
        onClose={() => setApplying(false)}
        onApply={async (kind, amountCents, reason) => {
          if (!profile) return;
          const outcome = await submitWrite(add, {
            /* The id is made here and sent, so a replay off the offline queue
               collides on the primary key instead of discounting twice.
               CATCH_UP_015 §3's pattern. */
            id: crypto.randomUUID(),
            salesInvoiceId: invoice.id,
            kind,
            amountCents,
            reason,
          });

          if (outcome.kind === 'failed') {
            /* The database's own sentence. `add_sales_adjustment` names what
               is left when the amount is too large, and that is the refusal
               somebody will actually hit. */
            toast.show(writeFailureMessage(outcome.error, 'Couldn’t apply that.'), 'problem');
            return;
          }

          setApplying(false);
          toast.show(
            kind === 'refund'
              ? `Refund of ${formatCents(amountCents)} recorded.`
              : `${formatCents(amountCents)} off. It prints on the invoice.`,
          );
        }}
      />

      <ConfirmDialog
        open={undoing !== null}
        title="Undo this?"
        points={
          undoing
            ? [
                <>
                  {describeAdjustment(undoing)} of {formatCents(undoing.amount_cents)} —{' '}
                  {undoing.reason}
                </>,
                <>
                  It stays in the record as undone, and stops coming off the invoice. The customer
                  will owe {formatCents(remaining + undoing.amount_cents)} again.
                </>,
              ]
            : []
        }
        confirmLabel="Undo it"
        onConfirm={async () => {
          if (!undoing) return;
          const target = undoing;
          setUndoing(null);
          const outcome = await submitWrite(undo, {
            id: target.id,
            salesInvoiceId: invoice.id,
            reason: null,
          });
          if (outcome.kind === 'failed') {
            toast.show(writeFailureMessage(outcome.error, 'Couldn’t undo that.'), 'problem');
            return;
          }
          toast.show('Undone. It stays in the record.');
        }}
        onCancel={() => setUndoing(null)}
      />
    </section>
  );
}

/**
 * What is being taken off, how much, and why.
 *
 * The reason is required by the form as well as by the database, and it is the
 * only field here that could have been optional. It is not: §28.3 refused a
 * bare `amount_received_cents` precisely because a figure with no explanation
 * is the thing people end up arguing about, and a reason nobody typed is that
 * figure with extra steps.
 */
function ApplySheet({
  open,
  invoice,
  remaining,
  pending,
  onClose,
  onApply,
}: {
  open: boolean;
  invoice: SalesInvoiceRow;
  remaining: number;
  pending: boolean;
  onClose: () => void;
  onApply: (kind: 'discount' | 'refund', amountCents: number, reason: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<'discount' | 'refund'>('discount');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const cents = parseAmountToCents(amount);
  const tooMuch = cents !== null && cents > remaining;
  const ready = cents !== null && !tooMuch && reason.trim() !== '';

  const field =
    'w-full rounded-sm border border-hairline bg-card px-3 py-2 text-base text-ink outline-none focus:border-action';

  return (
    <Sheet
      open={open}
      title="Take something off"
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={!ready || pending}
          onClick={() => {
            if (cents === null) return;
            void onApply(kind, cents, reason.trim());
          }}
          className="touch w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
        >
          {pending ? 'Applying…' : 'Apply'}
        </button>
      }
    >
      {/*
        Two kinds, and they are not a sign on a number.

        A DISCOUNT reduces what is owed before it is settled; a REFUND gives
        money back after it has been. The arithmetic is identical and the
        distinction is for whoever reads this invoice next year — which is why
        it is a choice rather than something inferred from whether the invoice
        has been received.
      */}
      <div className="mb-4 flex gap-2" role="group" aria-label="What kind">
        {(
          [
            { key: 'discount', label: 'Discount' },
            { key: 'refund', label: 'Refund' },
          ] as const
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setKind(option.key)}
            aria-pressed={kind === option.key}
            className={`touch flex-1 rounded-full border px-3 text-sm ${
              kind === option.key
                ? 'border-action bg-action text-action-text'
                : 'border-hairline bg-card text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">How much</span>
        <input
          type="text"
          inputMode="decimal"
          aria-label="Amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          className={`money ${field}`}
        />
        <span className="mt-1 block text-xs text-muted">
          {tooMuch
            ? `That is more than the ${formatCents(remaining)} still owed on this invoice.`
            : `${formatCents(remaining)} of ${formatCents(invoice.amount_cents)} is still owed.`}
        </span>
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Why</span>
        <input
          type="text"
          aria-label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Short delivery"
          className={field}
        />
        <span className="mt-1 block text-xs text-muted">
          This prints on the invoice, under the total.
        </span>
      </label>
    </Sheet>
  );
}
