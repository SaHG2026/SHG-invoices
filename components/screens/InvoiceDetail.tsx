'use client';

import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { PersonChip } from '@/components/ui/PersonChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MarkPaidSheet } from '@/components/invoice/MarkPaidSheet';
import { useToast } from '@/components/ui/Toast';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useProfiles, useCurrentProfile } from '@/lib/queries/session';
import { useAddNote, useInvoice, useInvoiceActivity, useInvoiceNotes } from '@/lib/queries/detail';
import { useUnmarkPaid, useVoidInvoice } from '@/lib/queries/payments';
import { submitWrite } from '@/lib/offline/submit';
import { describeActivity, mergeStream } from '@/lib/derive/activity';
import { formatDateTime, formatDayWithYear } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { formatDaysLate, URGENCY_COLOUR, urgencyOf } from '@/lib/derive/urgency';
import type { Profile, StreamItem } from '@/lib/types';

/**
 * One invoice, in full. Spec §7.6.
 *
 * Below the facts, "a single chronological stream mixing notes and activity",
 * distinguished by weight rather than by tabs. Tabs would let somebody read
 * the notes and miss the fact that the amount was changed underneath them, and
 * this is the screen people open when they disagree about an invoice.
 *
 * Un-ticking lives here and nowhere else — spec §6 is explicit that it must
 * not be swipeable from a list, because that is too easy to fat-finger.
 */

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-2 last:border-b-0">
      <dt className="shrink-0 text-xs uppercase tracking-widest text-muted">{label}</dt>
      <dd className="figure-date min-w-0 text-right text-sm text-ink">{children}</dd>
    </div>
  );
}

function StreamLine({ item, people }: { item: StreamItem; people: readonly Profile[] }) {
  const actor = people.find((person) => person.id === item.actorId);
  const name = actor?.display_name ?? 'Someone';

  return (
    <li className="flex gap-3 border-b border-hairline py-3 last:border-b-0">
      {actor ? <PersonChip profile={actor} /> : <span className="size-6 shrink-0" />}

      <div className="min-w-0 flex-1">
        {item.kind === 'note' ? (
          <>
            {/* A note carries the weight — it is what a person chose to say. */}
            <p className="text-sm text-ink">{item.note.body}</p>
            <p className="mt-1 text-xs text-muted">
              {name} · {formatDateTime(item.at)}
            </p>
          </>
        ) : (
          <ActivityLine name={name} item={item} />
        )}
      </div>
    </li>
  );
}

function ActivityLine({ name, item }: { name: string; item: Extract<StreamItem, { kind: 'activity' }> }) {
  const described = describeActivity(item.entry);

  return (
    <>
      <p className="text-sm text-muted">
        <span className="text-ink">{name}</span> {described.summary}
        {described.reference ? (
          <>
            {' · ref '}
            <span className="figure-date text-ink">{described.reference}</span>
          </>
        ) : null}
      </p>

      {described.changes.length > 0 ? (
        <ul className="mt-1">
          {described.changes.map((change) => (
            <li key={change.label} className="figure-date text-sm text-ink">
              <span className="text-muted">{change.label}: </span>
              {change.from ?? '—'} → {change.to ?? '—'}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-1 text-xs text-muted">{formatDateTime(item.at)}</p>
    </>
  );
}

export function InvoiceDetail({ id }: { id: string }) {
  const toast = useToast();
  const today = useSydneyToday();
  const { data: profile } = useCurrentProfile();
  const { data: people = [] } = useProfiles();
  const { data: invoice, isLoading } = useInvoice(id);
  const { data: activity = [] } = useInvoiceActivity(id);
  const { data: notes = [] } = useInvoiceNotes(id);

  const addNote = useAddNote();
  const unmarkPaid = useUnmarkPaid();
  const voidInvoice = useVoidInvoice();

  const [noteText, setNoteText] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [confirmUnpaid, setConfirmUnpaid] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  const stream = useMemo(() => mergeStream(activity, notes), [activity, notes]);
  const payer = people.find((person) => person.id === invoice?.paid_by);

  if (isLoading) {
    return (
      <AppChrome back={{ href: '/' as Route, label: 'Back' }}>
        <p className="text-sm text-muted">Loading…</p>
      </AppChrome>
    );
  }

  if (!invoice) {
    return (
      <AppChrome back={{ href: '/' as Route, label: 'Back' }}>
        <h1 className="text-h2 text-ink">No such invoice</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been opened from an old link. Nothing is ever deleted, so if it existed it is
          still in the history.
        </p>
      </AppChrome>
    );
  }

  const urgency = today ? urgencyOf(invoice.due_date, today) : 'later';
  const late = today ? formatDaysLate(invoice.due_date, today) : null;

  async function submitNote(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || noteText.trim() === '') return;
    const body = noteText;
    setNoteText('');

    const outcome = await submitWrite(addNote, {
      // Decided here so a note replayed from the queue conflicts on the primary
      // key rather than appearing twice under the same invoice.
      id: crypto.randomUUID(),
      invoiceId: id,
      body,
      authorId: profile.id,
    });

    if (outcome.kind === 'failed') {
      setNoteText(body);
      toast.show('Couldn’t add that note. Nothing was written.', 'problem');
      return;
    }

    if (outcome.kind === 'queued') {
      toast.show('Note saved — will send when you’re back online.', 'queued');
    }
  }

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Back' }}>
      <header className="mb-4">
        <p className="figure-date text-xs uppercase tracking-widest text-muted">
          {invoice.internal_ref}
        </p>
        <h1 className="text-h1 text-ink">{invoice.supplier.name}</h1>
        <p className="money mt-2 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(invoice.amount_cents)}
        </p>
      </header>

      {invoice.status === 'paid' ? (
        <p
          className="mb-4 flex items-center gap-2 rounded-sm px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--paid-bg)', color: 'var(--paid)' }}
        >
          {payer ? <PersonChip profile={payer} /> : null}
          Paid{payer ? ` by ${payer.display_name}` : ''}
          {invoice.paid_at ? ` · ${formatDateTime(invoice.paid_at)}` : ''}
          {invoice.payment_ref ? ` · ref ${invoice.payment_ref}` : ''}
        </p>
      ) : null}

      {invoice.status === 'void' ? (
        <p
          className="mb-4 rounded-sm px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--spine-later-bg)', color: 'var(--muted)' }}
        >
          Voided{invoice.void_reason ? ` — ${invoice.void_reason}` : ''}
        </p>
      ) : null}

      <dl className="mb-4 rounded-sm border border-edge bg-card px-3 py-1">
        <Fact label="Business">{invoice.business.name}</Fact>
        <Fact label="Invoice date">{formatDayWithYear(invoice.invoice_date)}</Fact>
        <Fact label="Due">
          <span style={{ color: invoice.status === 'unpaid' ? URGENCY_COLOUR[urgency] : undefined }}>
            {formatDayWithYear(invoice.due_date)}
            {invoice.status === 'unpaid' && late ? ` · ${late}` : ''}
          </span>
        </Fact>
        {invoice.invoice_number ? (
          <Fact label="Invoice number">{invoice.invoice_number}</Fact>
        ) : null}
      </dl>

      {/* Actions. What is offered depends on where the invoice already is. */}
      <div className="mb-6 flex flex-wrap gap-2">
        {invoice.status === 'unpaid' ? (
          <>
            <button
              type="button"
              onClick={() => setPayOpen(true)}
              className="touch flex-1 rounded-full px-4 text-base font-medium"
              style={{ backgroundColor: 'var(--paid)', color: 'var(--card)' }}
            >
              Mark paid
            </button>
            <button
              type="button"
              onClick={() => setVoidOpen(true)}
              className="touch rounded-sm border border-hairline bg-card px-4 text-sm text-muted"
            >
              Void
            </button>
          </>
        ) : null}

        {invoice.status === 'paid' ? (
          <button
            type="button"
            onClick={() => setConfirmUnpaid(true)}
            className="touch rounded-sm border border-hairline bg-card px-4 text-sm text-ink"
          >
            Put back to unpaid
          </button>
        ) : null}
      </div>

      {/* The stream. Spec §7.6: one list, weight not tabs. */}
      <section>
        <h2 className="text-h2 mb-2 text-ink">History</h2>
        {stream.length === 0 ? (
          <p className="rounded-sm border border-edge bg-card p-3 text-sm text-muted">
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="rounded-sm border border-edge bg-card px-3">
            {stream.map((item) => (
              <StreamLine
                key={item.kind === 'note' ? `n-${item.note.id}` : `a-${item.entry.id}`}
                item={item}
                people={people}
              />
            ))}
          </ul>
        )}

        <form onSubmit={submitNote} className="mt-3 flex gap-2">
          <input
            type="text"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="Add a note"
            aria-label="Add a note"
            className="touch min-w-0 flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
          <button
            type="submit"
            disabled={noteText.trim() === '' || addNote.isPending}
            className="touch shrink-0 rounded-full bg-action px-4 text-sm text-action-text disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </section>

      <MarkPaidSheet
        open={payOpen}
        invoices={[invoice]}
        onClose={() => setPayOpen(false)}
      />

      <ConfirmDialog
        open={confirmUnpaid}
        title="Put this back to unpaid?"
        points={[
          <>
            This invoice is marked paid
            {payer ? (
              <>
                {' by '}
                <strong>{payer.display_name}</strong>
              </>
            ) : null}
            {invoice.payment_ref ? (
              <>
                {', reference '}
                <strong>{invoice.payment_ref}</strong>
              </>
            ) : null}
            .
          </>,
          <>Putting it back is recorded in the history with your name on it.</>,
        ]}
        question="Are you sure?"
        confirmLabel="Put back to unpaid"
        onCancel={() => setConfirmUnpaid(false)}
        onConfirm={async () => {
          setConfirmUnpaid(false);
          try {
            await unmarkPaid.mutateAsync(invoice.id);
            toast.show('Put back to unpaid.');
          } catch {
            toast.show('Couldn’t change it — check your connection.', 'problem');
          }
        }}
      />

      {voidOpen ? (
        <ConfirmDialog
          open
          title="Void this invoice?"
          points={[
            <>
              It drops out of every total but stays in the history, struck through. Nothing is ever
              deleted.
            </>,
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-widest text-muted">
                Reason (required)
              </span>
              <input
                type="text"
                autoFocus
                value={voidReason}
                onChange={(event) => setVoidReason(event.target.value)}
                aria-label="Reason for voiding"
                className="touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
              />
            </label>,
          ]}
          confirmLabel="Void it"
          onCancel={() => {
            setVoidOpen(false);
            setVoidReason('');
          }}
          onConfirm={async () => {
            if (voidReason.trim() === '') {
              toast.show('A reason is needed before voiding.', 'problem');
              return;
            }
            setVoidOpen(false);
            try {
              await voidInvoice.mutateAsync({ id: invoice.id, reason: voidReason });
              setVoidReason('');
              toast.show('Voided.');
            } catch {
              toast.show('Couldn’t void it — check your connection.', 'problem');
            }
          }}
        />
      ) : null}
    </AppChrome>
  );
}
