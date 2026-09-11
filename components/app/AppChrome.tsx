'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';
import { AddInvoiceSheet } from '@/components/invoice/AddInvoiceSheet';
import { AddSalesInvoiceSheet } from '@/components/invoice/AddSalesInvoiceSheet';
import { ActivityBell } from './ActivityBell';
import { ConnectionStatus } from './ConnectionStatus';
import { NavDrawer } from './NavDrawer';
import { navDirection } from '@/lib/nav';

/**
 * The shell every signed-in screen sits inside.
 *
 * One place for the header, the menu and the `+` button, so they cannot drift
 * between screens and so a screen added later gets all three without asking.
 *
 * ARCHITECTURE §16: the `+` is global and reachable from everywhere. Reading
 * the ledger is hierarchical — dashboard, business, list — but writing to it
 * is not. The first metric is fifteen seconds from cold open to a saved
 * invoice, and making somebody walk into a business first would spend three of
 * them on navigation.
 *
 * The menu button is the counterpart: every destination is now one tap from
 * every screen, so the same is true of reading. `back` stays for the screens
 * where it means something specific — this invoice came from that list — and
 * is not a substitute for navigation.
 */

interface AppChromeProps {
  children: React.ReactNode;
  /** Shown in the header when you are inside a business rather than at home. */
  back?: { href: Route; label: string };
  /**
   * How the `+` appears. `floating` is the 56px corner button every list
   * screen uses; `bar` is a full-width button pinned across the bottom, for
   * the dashboard, where adding an invoice is the primary action rather than
   * one of several.
   *
   * Never both: two controls doing one thing, one of them overlapping the
   * other, is worse than either.
   *
   * `none` is for a screen that IS the act of adding something. The compose
   * screen has its own Save pinned across the bottom, and the floating `+`
   * landed on top of it -- a button offering to start a second invoice,
   * covering the button that finishes the first. Reported with a photograph.
   */
  add?: 'floating' | 'bar' | 'none';
  /**
   * What this screen is a list OF, offered first when the `+` is pressed.
   *
   * ---------------------------------------------------------------------------
   * The `+` used to mean "invoice" everywhere, including on Suppliers.
   *
   * Reported: *"the + on supplier interface is creating invoice still"*. It is
   * the right complaint. §16 made the `+` global because writing to the ledger
   * is not hierarchical — you should be able to log an invoice from anywhere
   * without walking into a business first — and that reasoning is sound and is
   * why the button is still there on every screen. But "global" was
   * implemented as "means one thing", and those are not the same claim.
   *
   * On a screen that is a list of suppliers, the thing under your thumb should
   * be able to add a supplier. Every one of these screens already HAS an add
   * panel, at the top, above a search box and above a list that on a real
   * Monday is thirty rows long — so the panel is a scroll away and the `+` is
   * not, and the `+` was pointing at the wrong ledger entirely.
   *
   * This does not replace the invoice path, it precedes it. Pressing `+` on
   * Suppliers now asks, with "New supplier" first and "From a supplier" under
   * it, exactly as Deli's screens have asked "which ledger" since Receivables
   * was added. Nothing is taken away; one thing is added above it.
   *
   * The dashboard passes nothing here, deliberately. It is the fifteen-second
   * path, it is what the app opens to, and a question there would cost a tap
   * on the one screen where taps are counted.
   * ---------------------------------------------------------------------------
   */
  addHere?: { label: string; onPress: () => void };
}

export function AppChrome({ children, back, add = 'floating', addHere }: AppChromeProps) {
  /*
   * Keyed on the path so the animation replays on every navigation.
   *
   * Without the key React reuses the same <main> across routes and the
   * animation, having already run once, never runs again — the content simply
   * swaps. Which is exactly the "jerky" the client described: nothing was
   * animating between screens at all.
   */
  const pathname = usePathname();

  /*
   * Which way this navigation went, so the screen arrives from the side you
   * came from. The previous path is a ref rather than state: it must not
   * itself cause a render, and it is read during the render that follows the
   * change — which is exactly the render whose animation depends on it.
   */
  const previousPath = useRef<string | null>(null);
  const direction = navDirection(previousPath.current, pathname ?? '/');
  previousPath.current = pathname ?? '/';

  const screenMotion =
    direction === 'forward' ? 'screen-push' : direction === 'back' ? 'screen-pop' : 'screen-in';

  /*
   * Deli Delights is the only business with two directions, so it is the only
   * place the `+` has to ask which one you mean. Everywhere else the answer is
   * "a supplier invoice" and a question with one right answer is not a
   * question — ARCHITECTURE §17.
   *
   * Receivables and Products joined the list when Receivables was added: both
   * are Deli's screens, and a `+` that opens a SUPPLIER sheet while you are
   * standing on the money customers owe you is the wrong ledger entirely.
   */
  const sellsAsWell = /^\/(b\/ddl|customers|receivables|products)(\/|$)/.test(pathname ?? '');
  const [salesOpen, setSalesOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  /*
   * The `+` asks a question only when there is more than one true answer.
   * A question with one right answer is not a question — §17, and it is what
   * keeps the dashboard at one tap.
   */
  function pressedAdd() {
    if (addHere || sellsAsWell) setAsking(true);
    else setSheetOpen(true);
  }
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      {/*
        `no-print` on the shell itself, not a selector in the stylesheet
        guessing at it.

        The print rules first targeted `header[data-app-header]`, an attribute
        nothing here has, so the hamburger and the icons printed at the top of
        every invoice — and nothing on screen could have shown that, because
        the rule only exists on paper. Marking the element is the version that
        cannot silently stop matching.
      */}
      {/*
        The dark band. Round G, from the client's design.

        It is `--hero`, the same material as the total-outstanding card, not
        `--brand`: brand is the PWA splash and browser-chrome colour and has to
        keep matching the installed icon exactly, so it is not available to be
        adjusted for a header. Two tokens because they answer two questions.

        Everything inside it switches to the light pair. That is the whole cost
        of a dark header and it is why the colours are tokens rather than
        utility classes — `text-ink` on this ground is 1.3:1.
      */}
      <header
        /*
         * NO `overflow-hidden` here, and it is not an oversight.
         *
         * Round H put it on to contain the ridge SVG, and it clipped the
         * activity panel — which is `absolute top-14`, i.e. deliberately
         * BELOW this 56px bar. The bell went dead: the panel rendered
         * correctly every time and was cut off at the header's own edge.
         *
         * The SVG never needed it. An outer <svg> clips to its own viewBox by
         * default, so the ridge cannot escape this element on its own.
         */
        className="no-print sticky top-0 z-30 relative"
        style={{
          backgroundColor: 'var(--hero)',
          backgroundImage: 'linear-gradient(160deg, var(--hero) 0%, var(--hero-deep) 100%)',
          color: 'var(--hero-text)',
        }}
      >
        <HimalayaRidge />
        {/* relative, so the bell panel can hang beneath the bar — and so the
            whole bar sits above the ridgeline behind it. */}
        <div className="relative z-10 mx-auto flex h-14 max-w-[560px] items-center gap-1 px-4">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Menu"
            className="touch -ml-3 flex shrink-0 items-center justify-center px-2"
            style={{ color: 'var(--hero-text)' }}
          >
            <MenuGlyph />
          </button>

          {back ? (
            <Link
              href={back.href}
              className="touch flex min-w-0 items-center gap-1 pr-1 text-sm"
              style={{ color: 'var(--hero-text)' }}
            >
              <span aria-hidden>‹</span>
              <span className="truncate">{back.label}</span>
            </Link>
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              {/*
                The same tile as the home screen icon, so the header confirms
                you are in the thing you tapped. A plain <img> rather than
                next/image: one static 28px square from our own origin has
                nothing for the optimiser to do.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icons/icon-64.png"
                alt=""
                width={28}
                height={28}
                className="shrink-0 rounded-sm"
              />
              {/*
                The name, and nothing else. The design carried a strapline
                under it for one round and it came straight back off:
                *"remove the manage track get paid. just have it as SHG
                invoices."*

                Right, and it is the same argument the app keeps making about
                itself — a strapline sells the product to somebody deciding
                whether to use it, and everybody who sees this header decided
                months ago. It was the only line in the app addressed to a
                visitor rather than to the four people who work here.
              */}
              <span
                className="truncate text-h2"
                style={{
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '-0.02em',
                  color: 'var(--hero-text)',
                }}
              >
                SHG Invoices
              </span>
            </span>
          )}

          <span className="flex-1" />

          {/*
            Home, next to the bell. The logo is a link on paper but it is not
            one here — on a deep screen the header shows a back link instead of
            the wordmark, so the only way home was the menu. Two taps for the
            screen the app opens to.
          */}
          <Link
            href={'/' as Route}
            aria-label="Home"
            className="touch flex shrink-0 items-center justify-center px-1"
            style={{ color: 'var(--hero-muted)' }}
          >
            <HomeGlyph />
          </Link>

          <ConnectionStatus />

          <ActivityBell />

          {/*
            The profile chip used to sit here, linking to Settings. Removed at
            the client's request, and it costs nothing: the menu opens with the
            same chip, the same name and the same link, and the menu button is
            two centimetres to the left on every screen.

            What the space buys is the connection symbol above, which is the
            one thing in this header that changes on its own.
          */}
        </div>
      </header>

      <main key={pathname} className={`${screenMotion} mx-auto max-w-[560px] px-4 pb-28 pt-6`}>
        {children}
      </main>

      {/*
        The name follows what the button does. On a list screen it opens a
        choice, and a screen reader announcing "Add invoice" for a control
        whose first option is "New supplier" is the same broken promise §39.1
        caught in a link label — a label is a promise, and an unkept one reads
        as broken.
      */}
      {add === 'none' ? null : add === 'floating' ? (
        <button
          type="button"
          onClick={pressedAdd}
          aria-label={addHere ? 'Add' : 'Add invoice'}
          className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-full bg-action text-h1 text-action-text shadow-(--shadow-lift)"
          style={{ bottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
        >
          +
        </button>
      ) : (
        /*
          Pinned rather than sitting at the end of the page.
          In the mockup it follows a list of four; on a real Monday it follows
          a list of thirty, and a button that has scrolled out of sight is a
          button that is not reachable — which is three seconds off the
          fifteen-second target, on the one screen the app opens to.
        */
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-card px-4 pt-3"
          style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom, 0px))` }}
        >
          <button
            type="button"
            onClick={pressedAdd}
            className="touch mx-auto flex w-full max-w-[528px] items-center justify-center gap-2 rounded-full bg-action px-4 text-base font-medium text-action-text"
          >
            <span aria-hidden>+</span>
            New invoice
          </button>
        </div>
      )}

      {menuOpen ? <NavDrawer onClose={() => setMenuOpen(false)} /> : null}

      {/*
        Which one? Asked inside Deli Delights and on the customer screens
        (which ledger), and on any screen that is a list of something (that
        thing, or an invoice). Large targets rather than a dropdown: this is
        the first thing between a person and entering an invoice, and it should
        cost one tap and no reading.
      */}
      {asking ? (
        <div
          className="fixed inset-0 z-50 flex items-end"
          role="dialog"
          aria-modal="true"
          aria-label={addHere ? 'What would you like to add?' : 'What kind of invoice?'}
        >
          <div
            aria-hidden
            onClick={() => setAsking(false)}
            className="scrim-in absolute inset-0 bg-ink/40"
          />
          <div
            className="sheet-in relative w-full bg-card p-4"
            style={{
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              paddingBottom: `calc(1rem + env(safe-area-inset-bottom, 0px))`,
            }}
          >
            <p className="mb-3 text-xs uppercase tracking-widest text-muted">
              {addHere ? 'Add' : 'New invoice'}
            </p>

            {/*
              First, because it is what this screen is about. Somebody who
              pressed `+` on Suppliers meant a supplier far more often than
              they meant an invoice — and if they did mean the invoice it is
              still one tap, directly underneath.
            */}
            {addHere ? (
              <button
                type="button"
                onClick={() => {
                  setAsking(false);
                  addHere.onPress();
                }}
                className="touch mb-2 flex w-full items-center rounded-sm border border-edge px-4 text-left text-base font-medium text-ink"
              >
                <span className="text-base font-medium text-ink">{addHere.label}</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setSheetOpen(true);
              }}
              className={`touch ${sellsAsWell ? 'mb-2' : 'mb-3'} flex w-full items-center rounded-sm border border-edge px-4 text-left text-base font-medium text-ink`}
            >
              <span className="text-base font-medium text-ink">
                {addHere ? 'Invoice from a supplier' : 'From a supplier'}
              </span>
            </button>

            {/*
              Only where there genuinely is a second ledger. On Suppliers this
              row would offer to invoice a customer from a screen that has
              nothing to do with customers.
            */}
            {sellsAsWell ? (
              <button
                type="button"
                onClick={() => {
                  setAsking(false);
                  setSalesOpen(true);
                }}
                className="touch mb-3 flex w-full items-center rounded-sm border border-edge px-4 text-left text-base font-medium text-ink"
              >
                <span className="text-base font-medium text-ink">
                  {addHere ? 'Invoice to a customer' : 'To a customer'}
                </span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => setAsking(false)}
              className="touch w-full rounded-full border border-hairline text-sm text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <AddInvoiceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
      <AddSalesInvoiceSheet open={salesOpen} onClose={() => setSalesOpen(false)} />
    </div>
  );
}

/**
 * Drawn rather than typed, for the reason the chevron in NavDrawer is: ☰ is a
 * real character and it renders at three different weights across iOS, Android
 * and desktop, sometimes as an emoji. This is the same three lines everywhere.
 */
/**
 * The Himalaya, behind the header.
 *
 * Asked for by name — *"add the mountain ranges in the background.
 * himalayas."* — and drawn rather than photographed, for the reason
 * `lib/logos.ts` gives about explicit tables: an SVG is a few hundred bytes
 * that is right on every screen and every density, where a background
 * photograph is a network request that arrives after the header has painted
 * and shifts nothing but costs everybody data on shop wifi.
 *
 * Two ranges, the far one lighter, because a single silhouette reads as a
 * shape and two read as distance.
 *
 * They run the full width but stay in the BOTTOM THIRD, and that is the whole
 * of the placement decision. The first attempt put proper peaks across the
 * middle and they landed squarely behind the wordmark and the three icons —
 * a mountain behind a letterform is the thing that makes a header look cheap.
 * A 56px bar has no room above the controls, so the range became a horizon
 * under them instead: the same scenery, in the only band of this header that
 * is actually empty.
 *
 * `preserveAspectRatio="none"` deliberately — this is scenery being stretched
 * to a bar, not a diagram whose proportions carry meaning.
 */
function HimalayaRidge() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 400 56"
      preserveAspectRatio="none"
      fill="none"
    >
      {/* The far range: lower, softer, and it never meets the near one's
          peaks, which is what stops the two reading as one jagged line. */}
      <path
        d="M0 56 L34 40 L62 47 L96 34 L124 44 L158 33 L192 45 L226 35 L258 46 L292 32 L322 43 L354 36 L382 45 L400 38 L400 56 Z"
        fill="var(--hero-ridge)"
        opacity="0.5"
      />
      {/* The near range, with a snow line on the two peaks that carry it. */}
      <path
        d="M0 56 L40 46 L74 51 L110 41 L142 49 L178 38 L210 48 L244 42 L276 50 L310 39 L342 48 L374 43 L400 49 L400 56 Z"
        fill="var(--hero-ridge)"
      />
      <path
        d="M178 38 L185 43 L181 44 L178 42 L174 45 L171 42 Z"
        fill="var(--hero-muted)"
        opacity="0.45"
      />
      <path
        d="M310 39 L317 44 L313 45 L310 43 L306 46 L303 43 Z"
        fill="var(--hero-muted)"
        opacity="0.45"
      />
    </svg>
  );
}

function HomeGlyph() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.7 7.2 9 2.4l6.3 4.8v7.2a.9.9 0 0 1-.9.9h-3.6v-4.5H6.2v4.5H3.6a.9.9 0 0 1-.9-.9V7.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuGlyph() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export { useSydneyToday } from '@/hooks/use-sydney-today';
