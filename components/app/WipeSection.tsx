'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '@/components/ui/Toast';
import { useIsOnline, useQueuedWriteCount } from '@/lib/offline/pending';
import { useWipeEverything, WIPE_PHRASE, type WipeCounts } from '@/lib/queries/wipe';
import { ExportFiles } from './ExportSection';
import { runExport, type ExportResult } from '@/lib/export/run';

/**
 * Clearing the records, from inside the app. ARCHITECTURE §49.5, J4.
 *
 * ===========================================================================
 * Four conscious acts, and the client designed them.
 *
 * `db/RESET_TO_CLEAN_SLATE.sql` already empties the app. It is a file run
 * deliberately in another tool, and **that friction was doing real work** — so
 * moving it into a screen means replacing the friction rather than removing
 * it. He was told that, and answered with a better design than the objection
 * (§44.5):
 *
 *   1. Confirm.
 *   2. Type "Wipe everything".
 *   3. Be offered the full export first — take it or decline it.
 *   4. Then wipe.
 *
 * Four conscious acts cannot be butter fingers. Each of the four below is a
 * separate screen with its own way back, and none of them is a checkbox on
 * the same page as the button.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * The order of the four is not arrangement.
 *
 * The export is offered THIRD — after the phrase, immediately before the
 * deletion. Offering it first would put it in front of somebody who has not
 * yet decided, where it reads as a step in a form and gets tapped past. Here
 * it is the last thing between them and an empty database, and it is the only
 * copy of the data that will exist afterwards: §33.1 accepted that there are
 * no backups, on the client's own reasoning that the records live elsewhere.
 * That acceptance is what makes this screen the last chance rather than a
 * convenience.
 * ---------------------------------------------------------------------------
 */

type Step = 'closed' | 'warn' | 'phrase' | 'export' | 'done';

export function WipeSection() {
  const toast = useToast();
  const wipe = useWipeEverything();
  const online = useIsOnline();
  const queued = useQueuedWriteCount();

  const [step, setStep] = useState<Step>('closed');
  const [counts, setCounts] = useState<WipeCounts | null>(null);

  async function run() {
    try {
      const result = await wipe.mutateAsync();
      setCounts(result);
      setStep('done');
    } catch (error) {
      setStep('closed');
      /* The database's own sentence. Both refusals in `wipe_everything` are
         written to be read by a person. */
      toast.show(error instanceof Error ? error.message : 'Couldn’t clear the records.', 'problem');
    }
  }

  return (
    <section className="mb-4 rounded-sm border border-edge bg-card p-4">
      <p className="mb-1 text-xs uppercase tracking-widest text-muted">Start again</p>
      <p className="mb-3 text-sm text-muted">
        Empties every invoice, supplier, customer and product. Keeps the six logins, the four
        businesses, and everybody’s settings. It cannot be undone.
      </p>

      {/*
        Not styled as a danger button, and that is deliberate.

        Spec §9 reserves brick for overdue and says "never decoratively". A red
        button here would be the only red on a settings screen and would pull
        the eye to the one control nobody should be drawn to. What stops this
        being pressed by accident is the four steps behind it, not its colour —
        and a button that LOOKS dangerous but opens straight onto a wipe is
        far worse than a plain one that opens onto four questions.
      */}
      <button
        type="button"
        onClick={() => setStep('warn')}
        disabled={wipe.isPending}
        className="touch w-full rounded-full border border-hairline bg-card px-4 text-base text-action disabled:opacity-40"
      >
        Clear all records…
      </button>

      {step === 'warn' ? (
        <WarnStep
          online={online}
          queued={queued}
          onContinue={() => setStep('phrase')}
          onCancel={() => setStep('closed')}
        />
      ) : null}

      {step === 'phrase' ? (
        <PhraseStep onContinue={() => setStep('export')} onCancel={() => setStep('closed')} />
      ) : null}

      {step === 'export' ? (
        <ExportStep
          running={wipe.isPending}
          onWipe={() => void run()}
          onCancel={() => setStep('closed')}
        />
      ) : null}

      {step === 'done' && counts ? (
        <DoneStep counts={counts} onClose={() => setStep('closed')} />
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * The shell every step shares.
 * -------------------------------------------------------------------------- */

function Sheet({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: (() => void) | null;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!onCancel) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel?.();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  /* Into `document.body`, for the reason ConfirmDialog gives in full: `<main
     class="screen-in">` keeps an identity transform after its animation, which
     makes it a containing block, which puts a `fixed inset-0` child hundreds
     of pixels below the fold on a long screen. These four sheets are the ones
     that must not be missable. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);

  if (!host) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-6"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      {/*
        The backdrop closes the first three steps and is hidden from assistive
        technology, because the explicit button does the same job and two
        elements announcing one name is confusing to hear (ConfirmDialog).

        It does NOT close the last one: after the wipe there is nothing to go
        back to, and dismissing that step by tapping beside it would mean
        never reading what happened.
      */}
      <div
        aria-hidden
        onClick={onCancel ?? undefined}
        className="absolute inset-0 bg-ink/60"
      />

      <div className="row-in relative max-h-[85vh] w-full max-w-[380px] overflow-y-auto rounded-sm bg-card shadow-(--shadow-dialog)">
        <div className="bg-today px-4 py-3">
          <h2
            className="text-h2 text-white"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
          >
            {title}
          </h2>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>,
    host,
  );
}

const POINT = 'border-t border-hairline py-3 text-base leading-snug text-ink first:border-t-0 first:pt-0';

/* -------------------------------------------------------------------------- *
 * 1. What this cannot reach.
 * -------------------------------------------------------------------------- */

/**
 * The first step is a warning about OTHER PHONES, not about this one.
 *
 * `RESET_TO_CLEAN_SLATE.sql` §1 spends its first screen on this and it was the
 * right thing to lead with: every phone can be holding work that has not been
 * sent, that queue does not know the wipe happened, and it will send
 * afterwards — leaving one invoice in an otherwise empty ledger. The wipe
 * clears the queue on the device that runs it and **cannot reach anybody
 * else's**.
 *
 * This device's own count is shown live, because it is the one number the app
 * can actually answer. A wipe pressed with something still waiting here would
 * destroy that work with no record of it anywhere, so it is refused outright
 * rather than warned about — the only hard stop in the four steps.
 */
function WarnStep({
  online,
  queued,
  onContinue,
  onCancel,
}: {
  online: boolean;
  queued: number;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const blocked = queued > 0 || !online;

  return (
    <Sheet title="Before you clear anything" onCancel={onCancel}>
      <ul>
        <li className={POINT}>
          Every phone can be holding invoices that haven’t been sent yet. This clears the ones on{' '}
          <strong>this</strong> phone and cannot reach anybody else’s — anything still waiting on
          another phone will arrive afterwards, into an empty ledger.
        </li>
        <li className={POINT}>
          Everybody should open the app with signal and wait for the number beside the wifi symbol
          to disappear before you do this.
        </li>
        <li className={POINT}>
          Afterwards, everyone should close the app completely and reopen it. It will show old
          invoices for a few seconds — that is a stale picture, not a failed wipe.
        </li>
      </ul>

      {queued > 0 ? (
        <p className="mt-3 text-base font-medium text-ink">
          {queued === 1
            ? 'One thing on this phone hasn’t sent yet. Wait for it before clearing anything.'
            : `${queued} things on this phone haven’t sent yet. Wait for them before clearing anything.`}
        </p>
      ) : !online ? (
        <p className="mt-3 text-base font-medium text-ink">
          This phone has no signal. Clearing the records needs a connection.
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={blocked}
          className="touch flex-1 rounded-full bg-action px-3 text-base text-action-text disabled:opacity-40"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="touch flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink"
        >
          Go back
        </button>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- *
 * 2. The phrase.
 * -------------------------------------------------------------------------- */

/**
 * Typed exactly, and compared against the same constant the RPC is called
 * with — notes §5, never two literals that happen to match today.
 *
 * The phrase is shown on the screen rather than remembered, because this is
 * not a password. What it is for is making the hand do something deliberate:
 * you cannot type eight letters by accident, and you cannot type them while
 * thinking about something else.
 */
function PhraseStep({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  const exact = typed === WIPE_PHRASE;

  return (
    <Sheet title="Type the words" onCancel={onCancel}>
      <p className="text-base leading-snug text-ink">
        To go on, type <strong>{WIPE_PHRASE}</strong> below, exactly.
      </p>

      <label className="mt-3 block">
        <span className="sr-only">Confirmation phrase</span>
        <input
          type="text"
          aria-label="Confirmation phrase"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          /* No autocorrect and no autocapitalise: a phone helpfully turning
             'Wipe everything' into 'Wipe Everything' would make a control that
             refuses correct typing, which reads as broken. */
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
        />
      </label>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={!exact}
          className="touch flex-1 rounded-full bg-action px-3 text-base text-action-text disabled:opacity-40"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="touch flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink"
        >
          Go back
        </button>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- *
 * 3. The export, offered. 4. The wipe.
 * -------------------------------------------------------------------------- */

/**
 * The last two acts share a screen, and that is the point of it.
 *
 * The offer and the deletion have to be visible at the same moment, or the
 * offer is a step somebody taps past on the way to the button. Here the button
 * that empties the database sits directly under a control that would save
 * everything first, and declining is an explicit tap on a control that says
 * what declining means.
 *
 * ---------------------------------------------------------------------------
 * No date range here, and NOT `ExportSection` embedded whole.
 *
 * It was, for one draft, and two things were wrong with it. The document then
 * held two identical forms with the same field labels and the same button
 * name — an accessible-name collision on a screen where the second one is
 * covering the first. And worse than that, it offered a CHOICE of period
 * directly above a button that deletes every period: exporting July and then
 * wiping everything is a mistake the screen would have helped somebody make.
 *
 * So this asks for the range that is the only correct one here — both ends
 * null, everything — and renders the same file list `ExportSection` does.
 * ---------------------------------------------------------------------------
 */
function ExportStep({
  running,
  onWipe,
  onCancel,
}: {
  running: boolean;
  onWipe: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [declined, setDeclined] = useState(false);
  const [building, setBuilding] = useState(false);
  const [files, setFiles] = useState<ExportResult | null>(null);

  async function build() {
    setBuilding(true);
    try {
      setFiles(await runExport({ from: null, to: null }));
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : 'Couldn’t build the export.',
        'problem',
      );
    } finally {
      setBuilding(false);
    }
  }

  return (
    <Sheet title="Take a copy first" onCancel={running ? null : onCancel}>
      <p className="text-base leading-snug text-ink">
        There are no backups. Once this is done, these files are the only copy of what was in the
        app.
      </p>

      {files ? (
        <ExportFiles result={files} />
      ) : (
        <button
          type="button"
          onClick={() => void build()}
          disabled={building}
          className="touch mt-3 w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
        >
          {building ? 'Gathering…' : 'Prepare a copy of everything'}
        </button>
      )}

      {declined ? (
        <>
          <p className="mt-1 text-base font-medium text-ink">
            Clear every invoice, supplier, customer and product? This cannot be undone.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onWipe}
              disabled={running}
              className="touch flex-1 rounded-full bg-action px-3 text-base text-action-text disabled:opacity-40"
            >
              {running ? 'Clearing…' : 'Clear everything'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={running}
              className="touch flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink disabled:opacity-40"
            >
              Go back
            </button>
          </div>
        </>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {/*
            Stacked rather than side by side. Sharing a row, "I don't need a
            copy" wrapped onto two lines beside a one-line "Go back", which
            reads as a broken button rather than as a long label -- and
            shortening the label to fit would cost the sentence its meaning.

            Declining is its own tap, on a control that says what it means.
            Naming the button "Skip" would let somebody past without ever
            reading the sentence above.
          */}
          <button
            type="button"
            onClick={() => setDeclined(true)}
            className="touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink"
          >
            I don’t need a copy
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink"
          >
            Go back
          </button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * What was there, said once.
 *
 * The counts come from the database, taken before the deletes, and they are
 * the only receipt anybody gets — afterwards there is nothing left to count.
 * A toast would be the wrong container for it: this is the last time these
 * numbers exist anywhere in the app, and a message that fades after four
 * seconds is a message somebody's thumb can cover.
 */
function DoneStep({ counts, onClose }: { counts: WipeCounts; onClose: () => void }) {
  const lines: [number, string][] = [
    [counts.invoices, counts.invoices === 1 ? 'bill' : 'bills'],
    [counts.sales_invoices, counts.sales_invoices === 1 ? 'invoice Deli issued' : 'invoices Deli issued'],
    [counts.suppliers, counts.suppliers === 1 ? 'supplier' : 'suppliers'],
    [counts.customers, counts.customers === 1 ? 'customer' : 'customers'],
    [counts.products, counts.products === 1 ? 'product' : 'products'],
  ];

  return (
    <Sheet title="The records are cleared" onCancel={null}>
      <ul>
        {lines.map(([count, noun]) => (
          <li key={noun} className={POINT}>
            {count.toLocaleString('en-AU')} {noun}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-base leading-snug text-ink">
        Everybody should close the app completely and reopen it. Anything still waiting to send on
        another phone will arrive after this.
      </p>

      <button
        type="button"
        onClick={onClose}
        className="touch mt-4 w-full rounded-full bg-action px-3 text-base text-action-text"
      >
        Done
      </button>
    </Sheet>
  );
}
