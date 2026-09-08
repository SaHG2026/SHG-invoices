'use client';

import { useState } from 'react';
import { useIsOnline } from '@/lib/offline/pending';
import { useToast } from '@/components/ui/Toast';
import { canShareFile, downloadFile, shareFile } from '@/lib/pdf/share';
import { runExport, type ExportRange, type ExportResult } from '@/lib/export/run';
import { isDateStr } from '@/lib/date';

/**
 * Taking the records out of the app. ARCHITECTURE §49.4, J4.
 *
 * ===========================================================================
 * In his words: *"from this date to this date export in excel or csv etc."*
 *
 * CSV rather than a real `.xlsx`, and §33.2 named the question that decides
 * between them: what happens to the file when it arrives. If it is opened,
 * read and closed, CSV is right; if it is kept, formatted and handed to
 * somebody, the half day and the first dependency added purely for output are
 * worth it. He has not answered, so this is the version that costs nothing to
 * replace — and every one of these files opens in Excel by double-clicking it.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * Prepare, then save each file. Not one button that downloads three things.
 *
 * Chrome blocks a second download from the same gesture and asks about it
 * with a permission bar that is easy to miss on a phone; Android's own
 * downloads UI then shows one file of three and looks like a failure. So the
 * work happens once, and the three files sit on the screen with their row
 * counts until somebody saves them.
 *
 * The counts are the point of that as much as the download blocking is. "412
 * bills" in front of somebody before they save anything is the only chance
 * they get to notice that the period they typed was not the period they meant.
 * ---------------------------------------------------------------------------
 */
export function ExportSection() {
  const toast = useToast();
  const online = useIsOnline();

  /*
   * Both ends optional, and empty means unbounded — which is why they are
   * plain strings here and turned into nulls at the edge. An `<input
   * type="date">` reports '' when it is empty, which is exactly the "no bound"
   * the range wants, so the two agree without a translation step. The same
   * shape the reminder time uses in SettingsScreen, for the same reason.
   */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const range: ExportRange = {
    from: isDateStr(from) ? from : null,
    to: isDateStr(to) ? to : null,
  };

  /* Stated before the button is pressed, not after. A backwards range is the
     one mistake that produces an empty file, and an empty file reads as "there
     was no business that month". */
  const backwards = range.from !== null && range.to !== null && range.from > range.to;

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const built = await runExport(range);
      setResult(built);
    } catch (error) {
      /* The reason, not "something went wrong". `ExportTooLarge` says which
         period to narrow, and that sentence is the whole value of it. */
      toast.show(
        error instanceof Error ? error.message : 'Couldn’t build the export.',
        'problem',
      );
    } finally {
      setRunning(false);
    }
  }

  const field =
    'figure-date touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action disabled:opacity-50';

  return (
    <section className="mb-4 rounded-sm border border-edge bg-card p-4">
      <p className="mb-1 text-xs uppercase tracking-widest text-muted">Export</p>
      <p className="mb-3 text-sm text-muted">
        A spreadsheet of what has been logged. Leave the dates empty for everything.
      </p>

      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">From</span>
          <input
            type="date"
            aria-label="Export from"
            value={from}
            max={to || undefined}
            disabled={running}
            onChange={(event) => {
              setFrom(event.target.value);
              setResult(null);
            }}
            className={field}
          />
        </label>
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">To</span>
          <input
            type="date"
            aria-label="Export to"
            value={to}
            min={from || undefined}
            disabled={running}
            onChange={(event) => {
              setTo(event.target.value);
              setResult(null);
            }}
            className={field}
          />
        </label>
      </div>

      <p className="mt-1 text-xs text-muted">
        {backwards
          ? 'Those dates are the wrong way round.'
          : /*
             * Which date it goes by, said plainly.
             *
             * `useSupplierRange` makes its caller choose between the due date
             * and the invoice date and labels which it used, because the two
             * answer different questions. A file gets no such choice (§49.3),
             * so it says which one it is — an export nobody can describe is an
             * export nobody can check.
             */
            'By the date on the invoice, not the date it falls due.'}
      </p>

      <button
        type="button"
        onClick={() => void run()}
        disabled={running || backwards || !online}
        className="touch mt-3 w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
      >
        {running ? 'Gathering…' : 'Prepare export'}
      </button>

      {/* Not a failure and not a retry — there is simply nothing to read from.
          The queue's own indicator already says the app is offline; this says
          what that means for this one control. */}
      {online ? null : (
        <p className="mt-2 text-xs text-muted">
          This needs a connection — the app can only export what it can re-read.
        </p>
      )}

      {result ? <ExportFiles result={result} /> : null}
    </section>
  );
}

/**
 * The three files, with what is in each.
 *
 * Exported, because the wipe offers the same three files immediately before
 * deleting the data (§49.5) and a second list would be a second thing to keep
 * right. It does NOT reuse `ExportSection` whole: that would put a date range
 * on a screen where choosing one is a mistake — exporting July and then wiping
 * everything — and would leave two identical forms in the document.
 *
 * Share is offered only where `canShare({files})` says yes, exactly as §48.2
 * does for the PDF — never a dead button. On a desktop browser this is a
 * Download-only screen and says nothing about it.
 */
export function ExportFiles({ result }: { result: ExportResult }) {
  const toast = useToast();
  const [bills, sales, lines] = result.files;

  const rows = [
    { file: bills, title: 'Bills', count: result.counts.bills, noun: 'bills' },
    {
      file: sales,
      title: 'Deli’s invoices',
      count: result.counts.sales,
      noun: 'invoices Deli issued',
    },
    {
      file: lines,
      title: 'Deli’s invoice lines',
      count: result.counts.lines,
      noun: 'lines on those invoices',
    },
  ].filter(
    (row): row is { file: File; title: string; count: number; noun: string } =>
      row.file !== undefined,
  );

  return (
    <ul className="mt-3 border-t border-hairline pt-3">
      {rows.map(({ file, title, count, noun }) => (
        <li
          key={file.name}
          className="flex items-center gap-3 border-b border-hairline py-2 last:border-b-0"
        >
          <span className="min-w-0 flex-1">
            {/*
              What the file IS, not what it is called.

              The filename led this row for one draft and two of the three
              truncated at 375px -- and they truncated inside the date range,
              which is the only part that tells two exports in a folder apart.
              The half that matters was the half that disappeared, which is
              §46.1's shape. The period is in the two fields directly above
              this list, and the name is on the file when it lands.
            */}
            <span className="block truncate text-sm text-ink">{title}</span>
            <span className="block text-xs text-muted">
              {/* Zero said out loud. "0 bills" is a real answer to a real
                  period and reads very differently from a row that is missing. */}
              {count.toLocaleString('en-AU')} {noun}
            </span>
          </span>

          {canShareFile(file) ? (
            <button
              type="button"
              onClick={async () => {
                const outcome = await shareFile(file, file.name);
                /* Backing out of a share sheet is an ordinary thing to do and
                   must not produce a failure message — §48.2. */
                if (outcome === 'failed') toast.show('Couldn’t share that file.', 'problem');
              }}
              className="touch shrink-0 rounded-full border border-hairline bg-card px-3 text-sm text-action"
            >
              Share
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => downloadFile(file)}
            className="touch shrink-0 rounded-full border border-hairline bg-card px-3 text-sm text-action"
          >
            Save
          </button>
        </li>
      ))}
    </ul>
  );
}
