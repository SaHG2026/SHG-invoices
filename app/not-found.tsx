import Link from 'next/link';
import type { Route } from 'next';

/**
 * A url that is not a screen.
 *
 * Reached in practice by an old home-screen shortcut after a route is renamed,
 * or by a link somebody typed. Not by browsing: every destination in the app is
 * reachable from the menu, and none of them can be missing.
 *
 * Deliberately short. There is nothing useful to say about a wrong address
 * except that it is wrong and where the right ones are.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-6">
      <p className="mb-2 text-xs uppercase tracking-widest text-muted">Not found</p>

      <h1 className="mb-4 text-h1 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
        There&rsquo;s nothing here
      </h1>

      <p className="mb-6 text-base text-ink">
        That address isn&rsquo;t a screen in this app. It may have been renamed since the link was
        made.
      </p>

      <Link
        href={'/' as Route}
        className="touch flex w-full items-center justify-center rounded-full bg-action px-4 text-base font-medium text-action-text"
      >
        Go home
      </Link>
    </main>
  );
}
