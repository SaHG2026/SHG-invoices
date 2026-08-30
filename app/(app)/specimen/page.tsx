'use client';

import { formatCents, formatCentsRounded } from '@/lib/money';
import { formatDay, formatDayWithYear } from '@/lib/date';
import {
  bucketByUrgency,
  formatDaysLate,
  URGENCY_COLOUR,
  URGENCY_TINT,
  type Urgency,
} from '@/lib/derive/urgency';
import { groupIntoRuns } from '@/lib/derive/runs';
import { summarise } from '@/lib/derive/select';
import { PersonChip, PERSON_SLOTS } from '@/components/ui/PersonChip';
import { FIXTURE_TODAY, PROFILES, makeInvoices } from '@/test/fixtures/invoices';

/**
 * The token specimen.
 *
 * Not a screen from the spec — a page to check the palette on a phone before
 * more is built on top of it. It renders from the same 200-invoice fixture the
 * tests use, so the money, dates and urgency shown here come from the real
 * functions rather than being mocked up.
 *
 * Every swatch below reads its colour from a CSS variable. Nothing on this
 * page hardcodes a hex, which means it cannot drift from app/globals.css and
 * quietly document a palette the app no longer uses.
 */

const SURFACES = [
  ['--page', 'app background'],
  ['--card', 'invoice cards, header, drawer'],
  ['--hairline', 'rules inside white cards'],
  ['--hairline-hi', 'card edges against the page'],
  ['--text', 'primary text, all amounts'],
  ['--muted', 'secondary text, dates, counts'],
  ['--pressed', 'row and button pressed state'],
  ['--brand', 'auth screens, PWA splash, icon'],
] as const;

const MEANINGS = [
  ['--spine-overdue', 'past due'],
  ['--spine-today', 'due today'],
  ['--spine-week', 'due within 7 days'],
  ['--spine-later', 'beyond 7 days'],
  ['--paid', 'paid, cleared, the tick'],
  ['--action', 'primary buttons'],
] as const;

const TYPE_SCALE = [
  ['text-total', '44', 'Outstanding total. Once per screen.'],
  ['text-h1', '28', 'Screen titles'],
  ['text-h2', '20', 'Section headings'],
  ['text-base', '16', 'Body'],
  ['text-sm', '14', 'Secondary'],
  ['text-xs', '12', 'Labels, chips'],
] as const;

const SECTION_LABEL: Record<Urgency, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'Next 7 days',
  later: 'Later',
};

function Swatch({ token, use }: { token: string; use: string }) {
  return (
    <li className="flex items-center gap-3 border-b border-hairline py-2">
      <span
        className="size-8 shrink-0 rounded-sm border border-edge"
        style={{ backgroundColor: `var(${token})` }}
      />
      <code className="w-36 shrink-0 text-xs text-ink" style={{ fontFamily: 'var(--font-mono)' }}>
        {token}
      </code>
      <span className="text-xs text-muted">{use}</span>
    </li>
  );
}

export default function TokenSpecimen() {
  const invoices = makeInvoices(200);
  const summary = summarise(invoices);
  const buckets = bucketByUrgency(invoices, FIXTURE_TODAY);

  return (
    <main className="mx-auto max-w-[560px] px-4 py-8">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-muted">Design tokens</p>
        <h1 className="text-h1 text-ink">SHG Payments</h1>
        <p className="mt-1 text-sm text-muted">
          Rendered from the 200-invoice test fixture. Every figure comes from the real formatting and
          urgency functions, and every swatch reads a CSS variable.
        </p>
      </header>

      {/* ---------------------------------------------------- the headline -- */}
      <section className="mb-10 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Owing</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(summary.total_cents)}
        </p>
        <p className="mt-1 text-sm text-muted">
          across {summary.invoice_count} invoices · {summary.supplier_count} suppliers
        </p>
        <p className="mt-3 text-xs text-muted">
          Rounded, for comparison:{' '}
          <span className="money">{formatCentsRounded(summary.total_cents)}</span>
        </p>
      </section>

      {/* -------------------------------------------------------- surfaces -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Surfaces and text</h2>
        <ul className="border-t border-hairline">
          {SURFACES.map(([token, use]) => (
            <Swatch key={token} token={token} use={use} />
          ))}
        </ul>
      </section>

      {/* -------------------------------------------------------- meanings -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-1 text-ink">Colours that mean something</h2>
        <p className="mb-3 text-xs text-muted">
          Paid and the primary action are deliberately different colours. If they matched, &ldquo;do
          this&rdquo; and &ldquo;this is settled&rdquo; would look the same on the same screen.
        </p>
        <ul className="border-t border-hairline">
          {MEANINGS.map(([token, use]) => (
            <Swatch key={token} token={token} use={use} />
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------ type -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Type scale</h2>
        <ul className="border-t border-hairline">
          {TYPE_SCALE.map(([token, px, use]) => (
            <li key={token} className="border-b border-hairline py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className={`${token} text-ink`} style={{ fontFamily: 'var(--font-display)' }}>
                  $5,220.00
                </span>
                <span className="money shrink-0 text-xs text-muted">{px}px</span>
              </div>
              <p className="mt-1 text-xs text-muted">{use}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-hairline pt-4">
          <p className="text-base text-ink" style={{ fontFamily: 'var(--font-display)' }}>
            Archivo — display, signage not startup
          </p>
          <p className="text-base text-ink">IBM Plex Sans — body and UI</p>
          <p className="money text-base text-ink" style={{ textAlign: 'left' }}>
            IBM Plex Mono 0123456789 — every figure
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------------- chips -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-1 text-ink">Attribution chips</h2>
        <p className="mb-3 text-xs text-muted">
          Tinted background with dark accent text, not white on a solid block — at 11px white on a
          mid-tone is thin, and four solid blocks in a list is a lot of colour. The database stores
          which person, never which colour.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {PROFILES.map((profile) => (
            <span key={profile.id} className="flex items-center gap-2">
              <PersonChip profile={profile} />
              <span className="text-xs text-muted">{profile.display_name}</span>
            </span>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Slots: {PERSON_SLOTS.join(' · ')}
        </p>
      </section>

      {/* ----------------------------------------------------- tabular-nums */}
      <section className="mb-10">
        <h2 className="text-h2 mb-1 text-ink">Tabular figures</h2>
        <p className="mb-2 text-xs text-muted">
          Columns must not wobble. Left is tabular, right is not.
        </p>
        <div className="grid grid-cols-2 gap-4 border-t border-hairline pt-2">
          <div>
            {[112_233, 9_004, 1_111_111, 4_732_015].map((cents) => (
              <p key={cents} className="money text-sm text-ink">
                {formatCents(cents)}
              </p>
            ))}
          </div>
          <div>
            {[112_233, 9_004, 1_111_111, 4_732_015].map((cents) => (
              <p key={cents} className="text-right text-sm text-muted">
                {formatCents(cents)}
              </p>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- the spine ---- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-1 text-ink">The due spine</h2>
        <p className="mb-4 text-xs text-muted">
          Today is {formatDayWithYear(FIXTURE_TODAY)}. Three rows per section, from the fixture. The
          ramp reads hot to inert.
        </p>

        {(Object.keys(SECTION_LABEL) as Urgency[]).map((urgency) => {
          const rows = buckets[urgency].slice(0, 3);
          if (rows.length === 0) return null;

          return (
            <div key={urgency} className="mb-5">
              <div className="mb-1 flex items-baseline justify-between">
                <span
                  className="rounded-sm px-2 py-0.5 text-xs uppercase tracking-widest"
                  style={{
                    backgroundColor: URGENCY_TINT[urgency],
                    color: URGENCY_COLOUR[urgency],
                  }}
                >
                  {SECTION_LABEL[urgency]}
                </span>
                <span className="money text-xs text-muted">
                  {formatCents(buckets[urgency].reduce((a, r) => a + r.amount_cents, 0))}
                </span>
              </div>

              <div className="relative overflow-hidden rounded-sm border border-edge bg-card">
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ backgroundColor: URGENCY_COLOUR[urgency] }}
                />
                <ul>
                  {rows.map((row) => (
                    <li
                      key={row.id}
                      className="flex h-row items-center gap-3 border-b border-hairline pl-4 pr-3 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{row.supplier.name}</span>
                        <span className="figure-date block text-xs text-muted">
                          {formatDay(row.due_date)}
                          {formatDaysLate(row.due_date, FIXTURE_TODAY)
                            ? ` · ${formatDaysLate(row.due_date, FIXTURE_TODAY)}`
                            : ''}
                          {' · '}
                          {row.business.code}
                        </span>
                      </span>
                      <span className="money shrink-0 text-sm text-ink">
                        {formatCents(row.amount_cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </section>

      {/* --------------------------------------------------- payment runs -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-1 text-ink">Payment runs</h2>
        <p className="mb-3 text-xs text-muted">
          Invoices sharing a supplier and a due date collapse into one row — one transfer.
        </p>
        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {groupIntoRuns(invoices)
            .filter((run) => run.invoices.length > 1)
            .slice(0, 4)
            .map((run) => (
              <li
                key={run.key}
                className="flex h-row items-center gap-3 border-b border-hairline px-3 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{run.supplier.name}</span>
                  <span className="figure-date block text-xs text-muted">
                    {formatDay(run.due_date)} · {run.invoices.length} inv
                  </span>
                </span>
                <span className="money shrink-0 text-sm text-ink">
                  {formatCents(run.total_cents)}
                </span>
              </li>
            ))}
        </ul>
      </section>

      {/* ------------------------------------------------------- controls -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Controls</h2>
        <div className="flex flex-wrap gap-2">
          {['7d', '14d', '30d', 'Pick date'].map((label, i) => (
            <button
              key={label}
              type="button"
              className={`touch rounded-sm border px-4 text-sm ${
                i === 1
                  ? 'border-action bg-action text-action-text'
                  : 'border-hairline bg-card text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="touch mt-4 w-full rounded-sm bg-action px-4 text-base font-medium text-action-text"
        >
          Save invoice
        </button>

        <p
          className="mt-4 rounded-sm px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--paid-bg)', color: 'var(--paid)' }}
        >
          Marked paid · TFR-88213
        </p>
      </section>

      <footer className="border-t border-hairline pt-4 text-xs text-muted">
        <p>
          Radius 4px everywhere. Hairline rules, no gradients. Sentence case throughout. Every colour
          on this page comes from app/globals.css.
        </p>
      </footer>
    </main>
  );
}
