'use client';

import { useState } from 'react';
import { useIsOnline } from '@/lib/offline/pending';
import { useToast } from '@/components/ui/Toast';
import { useBusinesses } from '@/lib/queries/reference';
import { canShareFile, downloadFile, shareFile } from '@/lib/pdf/share';
import {
  runExport,
  type ExportFile,
  type ExportFormat,
  type ExportRequest,
  type ExportResult,
} from '@/lib/export/run';
import { isDateStr } from '@/lib/date';

/**
 * Taking the records out of the app. ARCHITECTURE §49.4 and §50.4, J4.
 *
 * ===========================================================================
 * In his words, over two rounds.
 *
 * First: *"from this date to this date export in excel or csv etc."* Then,
 * having seen it: *"choose to download it all (zip) or download of each
 * business individually, and when selected deli, it will download a csv with
 * payable and receivable on two sheets of the same excel."*
 *
 * The second message is what settled §33.2's long-open question. It asked what
 * happens to the file when it arrives — opened, read and closed, or kept and
 * handed to somebody. **Asking for tabs is the second answer**, so the
 * workbook is now the default and CSV is the alternative rather than the only
 * thing on offer.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * Prepare, then save. Not one button that downloads several things.
 *
 * Chrome blocks a second download from the same gesture and asks about it with
 * a permission bar that is easy to miss on a phone; Android's downloads UI then
 * shows one file of three and looks like a failure.
 *
 * The counts are as much the point as the download blocking is. "412 bills" in
 * front of somebody before they save anything is the only chance they get to
 * notice that the period they typed was not the period they meant.
 * ---------------------------------------------------------------------------
 */
export function ExportSection() {
  const toast = useToast();
  const online = useIsOnline();
  const { data: businesses = [] } = useBusinesses();

  /*
   * Both ends optional, and empty means unbounded — which is why they are
   * plain strings here and turned into nulls at the edge. An `<input
   * type="date">` reports '' when it is empty, which is exactly the "no bound"
   * the range wants, so the two agree without a translation step. The same
   * shape the reminder time uses in SettingsScreen, for the same reason.
   */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /* Null is every business, and it is the default: "download it all" is the
     question somebody has when they open this, and one business is the
     narrowing. */
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const request: ExportRequest = {
    from: isDateStr(from) ? from : null,
    to: isDateStr(to) ? to : null,
    businessId,
    format,
  };

  /* Stated before the button is pressed, not after. A backwards range is the
     one mistake that produces an empty file, and an empty file reads as "there
     was no business that month". */
  const backwards = request.from !== null && request.to !== null && request.from > request.to;

  /**
   * Any change to what is being asked for throws away what was built for the
   * last question. A Save button that writes a file for a period nobody has on
   * screen any more is worse than no Save button — the filename would be the
   * only thing disagreeing with it, and §49.4 already moved the filename off
   * the row.
   */
  function changed<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setResult(null);
    };
  }

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      setResult(await runExport(request));
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
            onChange={(event) => changed(setFrom)(event.target.value)}
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
            onChange={(event) => changed(setTo)(event.target.value)}
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

      {/*
        A dropdown for the business and pills for the format, which is not an
        arbitrary pairing. The businesses are a list that can grow and whose
        names are long; the format is a choice between exactly two things.
        Pills for a binary you flip, a list for a list — the same split
        PendingList already makes between its sort pills and its supplier
        filter.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="touch flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card px-2 text-sm text-ink">
          <span className="sr-only">Which business</span>
          <select
            aria-label="Which business"
            value={businessId ?? ''}
            disabled={running}
            onChange={(event) => changed(setBusinessId)(event.target.value || null)}
            className="w-full bg-transparent text-sm text-ink outline-none"
          >
            <option value="">All businesses</option>
            {businesses.map((business) => (
              <option key={business.id} value={business.id}>
                {business.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2" role="group" aria-label="File format">
          {(
            [
              { key: 'xlsx', label: 'Excel' },
              { key: 'csv', label: 'CSV' },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => changed(setFormat)(option.key)}
              aria-pressed={format === option.key}
              disabled={running}
              className={`touch rounded-full border px-3 text-sm disabled:opacity-40 ${
                format === option.key
                  ? 'border-action bg-action text-action-text'
                  : 'border-hairline bg-card text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/*
        What is about to land, in one line, before it is built.

        The KIND of thing this button produces changes with both controls — one
        workbook, one archive, or several separate files — and a button whose
        output changes shape depending on two settings above it should say
        which. It is also the only place the sheets get mentioned: nothing else
        on this screen would tell somebody Deli's file has tabs in it.
      */}
      <p className="mt-2 text-xs text-muted">{describe(businessId, format, businesses.length)}</p>

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
 * One sentence saying what the button will produce.
 *
 * Written out rather than assembled from fragments, because three of the four
 * cases differ by more than a noun — one is a workbook with tabs, one an
 * archive of workbooks, one several separate files — and a template covering
 * all four would end up saying something vague about "files".
 */
function describe(businessId: string | null, format: ExportFormat, count: number): string {
  if (businessId === null) {
    return format === 'xlsx'
      ? `A zip holding one Excel workbook for each of the ${count} businesses.`
      : 'A zip holding a CSV for each business, and for each side of its ledger.';
  }
  return format === 'xlsx'
    ? 'One Excel workbook. Deli’s has a sheet for bills, one for the invoices it issued, and one for their lines.'
    : 'One CSV per table — a CSV cannot hold more than one sheet.';
}

/**
 * What was built, and what is in it.
 *
 * Exported, because the wipe offers the same files immediately before deleting
 * the data (§49.5) and a second list would be a second thing to keep right. It
 * does NOT reuse `ExportSection` whole: that would put a date range and a
 * business picker on a screen where choosing either is a mistake.
 *
 * Share is offered only where `canShare({ files })` says yes, exactly as §48.2
 * does for the PDF — never a dead button. On a desktop browser this is a
 * Save-only list and says nothing about it.
 */
export function ExportFiles({ result }: { result: ExportResult }) {
  const toast = useToast();

  return (
    <ul className="mt-3 border-t border-hairline pt-3">
      {result.files.map((entry) => (
        <FileRow
          key={entry.file.name}
          entry={entry}
          onShareFailed={() => toast.show('Couldn’t share that file.', 'problem')}
        />
      ))}
    </ul>
  );
}

function FileRow({ entry, onShareFailed }: { entry: ExportFile; onShareFailed: () => void }) {
  const { file, title, counts } = entry;

  return (
    <li className="flex items-center gap-3 border-b border-hairline py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        {/*
          What the file IS, not what it is called.

          The filename led this row for one draft and two of three truncated at
          375px — inside the date range, which is the only part that tells two
          exports in a folder apart. The half that mattered was the half that
          disappeared, which is §46.1's shape. The period is in the two fields
          above the list, and the name is on the file when it lands.
        */}
        <span className="block truncate text-sm text-ink">{title}</span>
        <span className="block text-xs text-muted">
          {/* Zero said out loud. "0 bills" is a real answer to a real period
              and reads very differently from a row that is missing. */}
          {counts
            .map((line) => `${line.count.toLocaleString('en-AU')} ${line.label.toLowerCase()}`)
            .join(' · ')}
        </span>
      </span>

      {canShareFile(file) ? (
        <button
          type="button"
          onClick={async () => {
            const outcome = await shareFile(file, file.name);
            /* Backing out of a share sheet is an ordinary thing to do and must
               not produce a failure message — §48.2. */
            if (outcome === 'failed') onShareFailed();
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
  );
}
