'use client';

import { personPhoto } from '@/lib/logos';
import { useBrandAsset } from '@/lib/brand/context';
import type { Profile } from '@/lib/types';

/**
 * The attribution chip. Spec §9: "the app's only recurring colour-as-identity
 * device", 24px square, 4px radius, initials in Plex Mono.
 *
 * ---------------------------------------------------------------------------
 * Why `profiles.accent` holds a slot name and not a colour.
 *
 * It used to hold a hex value, straight from the database into a style
 * attribute. That put four colours outside the token file, which breaks the
 * one rule the palette is built on: hex values live in exactly one place.
 * Repainting the app would have silently missed the chips — and the chips are
 * the one thing on screen that identifies a person.
 *
 * So the database stores which person this is (`person-1`..`person-4`) and the
 * stylesheet decides what that looks like. Identity is a fact about the row;
 * colour is a presentation decision, and they belong in different places.
 *
 * Rendered as a tinted background with dark accent text rather than white on
 * a solid block, per the palette notes: at 11px, white on a mid-tone is thin
 * and hard to read, and four solid blocks in a list is a lot of colour.
 * ---------------------------------------------------------------------------
 */

const SLOTS = ['person-1', 'person-2', 'person-3', 'person-4'] as const;
type Slot = (typeof SLOTS)[number];

/**
 * Tolerates the legacy hex values still in the database until the catch-up SQL
 * is run, so the app keeps working either way rather than rendering something
 * broken in the meantime.
 */
function slotOf(profile: Pick<Profile, 'id' | 'accent'>): Slot {
  if ((SLOTS as readonly string[]).includes(profile.accent)) return profile.accent as Slot;

  // Legacy: derive a stable slot from the id so two people never collide and
  // nobody's chip changes colour between renders.
  let hash = 0;
  for (const character of profile.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return SLOTS[hash % SLOTS.length]!;
}

interface PersonChipProps {
  profile: Pick<Profile, 'id' | 'accent' | 'initials' | 'display_name'>;
  /** 24px is the list default; 48px is the unlock screen. */
  size?: 'sm' | 'lg';
}

export function PersonChip({ profile, size = 'sm' }: PersonChipProps) {
  const slot = slotOf(profile);

  // Uploaded first, then the bundled file, then initials. Same three levels as
  // BusinessMark, for the same reason.
  const uploaded = useBrandAsset('people', profile.display_name);
  const photo = uploaded ?? personPhoto(profile.display_name);

  /*
   * A photograph where there is one, initials where there is not.
   *
   * The chip's job is unchanged — spec §9 calls it "the app's only recurring
   * colour-as-identity device", and it is still the same 24px square in the
   * same place. A face is simply a faster read than two letters, and the
   * accent tint stays underneath it as the background, so somebody whose photo
   * has not loaded yet still sees the colour they already associate with that
   * person rather than an empty hole.
   *
   * Initials remain the fallback rather than a placeholder silhouette: they
   * carry the actual meaning, and a generic grey head carries none.
   */
  if (photo) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={photo}
        /*
          The name, not an empty alt. The initials it replaces were real text
          and were read out; a decorative image would silently drop the only
          thing on an invoice row saying who logged it. Where the name is
          already announced — the header link carries its own aria-label — that
          label wins and this is never reached.
        */
        alt={profile.display_name}
        className={`shrink-0 rounded-sm object-cover ${size === 'lg' ? 'size-12' : 'size-6'}`}
        style={{ backgroundColor: `var(--${slot}-bg)` }}
      />
    );
  }

  return (
    <span
      title={profile.display_name}
      className={`flex shrink-0 items-center justify-center rounded-sm font-medium ${
        size === 'lg' ? 'size-12 text-h2' : 'size-6'
      }`}
      style={{
        backgroundColor: `var(--${slot}-bg)`,
        color: `var(--${slot})`,
        fontFamily: 'var(--font-mono)',
        fontSize: size === 'lg' ? '18px' : '11px',
      }}
    >
      {profile.initials}
    </span>
  );
}

/** The four slots, for the specimen page and the seed documentation. */
export const PERSON_SLOTS = SLOTS;
