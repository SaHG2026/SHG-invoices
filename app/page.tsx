import { formatCents, formatCentsRounded } from '@/lib/money';
import { formatDay, formatDayWithYear } from '@/lib/date';
import { bucketByUrgency, formatDaysLate, URGENCY_COLOUR, type Urgency } from '@/lib/derive/urgency';
import { groupIntoRuns } from '@/lib/derive/runs';
import { summarise } from '@/lib/derive/select';
import { FIXTURE_TODAY, PROFILES, makeInvoices } from '@/test/fixtures/invoices';

/**
 * Phase 1 specimen.
 *
 * Not a screen from the spec — a page to look at the tokens on a phone and
 * say yes or no before four more phases are built on top of them. It renders
 * from the same 200-invoice fixture the tests use, so the money, dates and
 * urgency shown here are produced by the real functions, not mocked up.
 *
 * This page is deleted at Phase 4, when the real Home screen replaces it.
 */

const PALETTE = [
  ['ink', '#12384B', 'text, headers, the unlock screen'],
  ['slate', '#2E7C93', 'structure, links, this week'],
  ['gold', '#C9A227', 'primary action, due today'],
  ['chilli', '#4F8F2E', 'paid, cleared'],
  ['brick', '#A6392B', 'overdue only, never decorative'],
  ['snow', '#EDF0F0', 'page background'],
  ['card', '#FFFFFF', 'cards'],
  ['hair', '#D3DBDC', '1px rules'],
  ['mute', '#6B7C82', 'secondary text'],
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

export default function TokenSpecimen() {
  const invoices = makeInvoices(200);
  const summary = summarise(invoices);
  const buckets = bucketByUrgency(invoices, FIXTURE_TODAY);

  return (
    <main className="mx-auto max-w-[560px] px-4 py-8">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-mute">Phase 1 · tokens</p>
        <h1 className="text-h1 text-ink">SHG Payments</h1>
        <p className="mt-1 text-sm text-mute">
          Rendered from the 200-invoice test fixture. Every figure below comes from the real
          formatting and urgency functions.
        </p>
      </header>

      {/* ---------------------------------------------------- the headline -- */}
      <section className="mb-10 border-t border-hair pt-5">
        <p className="text-xs uppercase tracking-widest text-mute">Owing</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(summary.total_cents)}
        </p>
        <p className="mt-1 text-sm text-mute">
          across {summary.invoice_count} invoices · {summary.supplier_count} suppliers
        </p>
        <p className="mt-3 text-xs text-mute">
          Rounded, for comparison: <span className="money">{formatCentsRounded(summary.total_cents)}</span>
        </p>
      </section>

      {/* -------------------------------------------------------- palette -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Palette</h2>
        <ul className="border-t border-hair">
          {PALETTE.map(([name, hex, use]) => (
            <li key={name} className="flex items-center gap-3 border-b border-hair py-2">
              <span
                className="size-8 shrink-0 rounded-sm border border-hair"
                style={{ backgroundColor: hex }}
              />
              <span className="w-16 text-sm font-medium text-ink">{name}</span>
              <span className="money w-20 text-xs text-mute" style={{ textAlign: 'left' }}>
                {hex}
              </span>
              <span className="text-xs text-mute">{use}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ----------------------------------------------------------- type -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Type scale</h2>
        <ul className="border-t border-hair">
          {TYPE_SCALE.map(([token, px, use]) => (
            <li key={token} className="border-b border-hair py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className={`${token} text-ink`} style={{ fontFamily: 'var(--font-display)' }}>
                  $5,220.00
                </span>
                <span className="money shrink-0 text-xs text-mute">{px}px</span>
              </div>
              <p className="mt-1 text-xs text-mute">{use}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-hair pt-4">
          <p className="text-base text-ink" style={{ fontFamily: 'var(--font-display)' }}>
            Archivo — display, signage not startup
          </p>
          <p className="text-base text-ink">IBM Plex Sans — body and UI</p>
          <p className="money text-base text-ink" style={{ textAlign: 'left' }}>
            IBM Plex Mono 0123456789 — every figure
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- chips -- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Attribution chips</h2>
        <p className="mb-3 text-xs text-mute">
          24px square, 4px radius, Plex Mono 11px. Permanent once a payment is ticked.
        </p>
        <div className="flex gap-2">
          {PROFILES.map((profile) => (
            <span
              key={profile.id}
              className="flex size-6 items-center justify-center rounded-sm text-white"
              style={{
                backgroundColor: profile.accent,
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
              }}
              title={profile.display_name}
            >
              {profile.initials}
            </span>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------- tabular-nums */}
      <section className="mb-10">
        <h2 className="text-h2 mb-3 text-ink">Tabular figures</h2>
        <p className="mb-2 text-xs text-mute">
          Columns must not wobble. Left column is tabular, right is not.
        </p>
        <div className="grid grid-cols-2 gap-4 border-t border-hair pt-2">
          <div>
            {[112_233, 9_004, 1_111_111, 47_320_15].map((cents) => (
              <p key={cents} className="money text-sm text-ink">
                {formatCents(cents)}
              </p>
            ))}
          </div>
          <div>
            {[112_233, 9_004, 1_111_111, 47_320_15].map((cents) => (
              <p key={cents} className="text-right text-sm text-mute">
                {formatCents(cents)}
              </p>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- the spine ---- */}
      <section className="mb-10">
        <h2 className="text-h2 mb-1 text-ink">The due spine</h2>
        <p className="mb-4 text-xs text-mute">
          Today is {formatDayWithYear(FIXTURE_TODAY)}. Three rows per section, from the fixture.
        </p>

        {(Object.keys(SECTION_LABEL) as Urgency[]).map((urgency) => {
          const rows = buckets[urgency].slice(0, 3);
          if (rows.length === 0) return null;

          return (
            <div key={urgency} className="mb-5">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-widest text-mute">
                  {SECTION_LABEL[urgency]}
                </span>
                <span className="money text-xs text-mute">
                  {formatCents(buckets[urgency].reduce((a, r) => a + r.amount_cents, 0))}
                </span>
              </div>

              <div className="relative bg-card">
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ backgroundColor: URGENCY_COLOUR[urgency] }}
                />
                <ul>
                  {rows.map((row) => (
                    <li
                      key={row.id}
                      className="flex h-row items-center gap-3 border-b border-hair pl-4 pr-3 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{row.supplier.name}</span>
                        <span className="figure-date block text-xs text-mute">
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
        <p className="mb-3 text-xs text-mute">
          Invoices sharing a supplier and a due date collapse into one row — one transfer.
        </p>
        <ul className="border-t border-hair bg-card">
          {groupIntoRuns(invoices)
            .filter((run) => run.invoices.length > 1)
            .slice(0, 4)
            .map((run) => (
              <li
                key={run.key}
                className="flex h-row items-center gap-3 border-b border-hair px-3 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{run.supplier.name}</span>
                  <span className="figure-date block text-xs text-mute">
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
        <h2 className="text-h2 mb-3 text-ink">Touch targets</h2>
        <p className="mb-3 text-xs text-mute">
          Every pill below is 44px tall. Notes §4: a 32px pill is a rage-inducing miss rate at
          arm&rsquo;s length.
        </p>
        <div className="flex flex-wrap gap-2">
          {['+7d', '+14d', '+30d', 'Pick date'].map((label, i) => (
            <button
              key={label}
              type="button"
              className={`touch rounded-sm border px-4 text-sm ${
                i === 1
                  ? 'border-ink bg-ink text-white'
                  : 'border-hair bg-card text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="touch mt-4 w-full rounded-sm bg-gold px-4 text-base font-medium text-ink"
        >
          Save invoice
        </button>
      </section>

      <footer className="border-t border-hair pt-4 text-xs text-mute">
        <p>
          Radius 4px everywhere. Hairline rules, no shadows, no gradients. Sentence case throughout.
        </p>
      </footer>
    </main>
  );
}
