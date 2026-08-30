import { businessMark } from '@/lib/logos';
import type { Business } from '@/lib/types';

/**
 * A business's logo, or its letters until there is one.
 *
 * The sibling of PersonChip, and built on the same rule: identity is a fact
 * about the row, colour is a presentation decision, and hex values live only
 * in app/globals.css. So the fallback tile is drawn from tokens and the letters
 * are the thing that identifies it — the same code already stamped into every
 * internal ref, which makes it a label people have already learnt.
 *
 * The fallback is deliberately NOT one of the four person accents. Those mean
 * "who did this", and a business wearing one would quietly break the only
 * colour-as-identity device the app has (spec §9).
 */

interface BusinessMarkProps {
  business: Pick<Business, 'code' | 'name'>;
  /** 28px in the menu; 24px in a list row. */
  size?: 'sm' | 'md';
}

export function BusinessMark({ business, size = 'md' }: BusinessMarkProps) {
  const mark = businessMark(business.code);
  const px = size === 'md' ? 28 : 24;

  if (mark.src) {
    return (
      /*
        A plain <img>, not next/image. These are small static files served from
        the same origin at a fixed size — there is nothing for the optimiser to
        do, and next/image would put a loader and a layout wrapper between a
        28px tile and the screen.

        `alt` is empty on purpose: the business name is always rendered right
        beside it, and a screen reader announcing "GroceryMate Hurstville logo,
        GroceryMate Hurstville" is noise.
      */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={mark.src}
        alt=""
        width={px}
        height={px}
        className="shrink-0 rounded-sm object-contain"
        style={{ width: px, height: px }}
      />
    );
  }

  const label = mark.label ?? business.code;

  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-sm"
      style={{
        width: px,
        height: px,
        backgroundColor: 'var(--pressed)',
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: size === 'md' ? '10px' : '9px',
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </span>
  );
}
