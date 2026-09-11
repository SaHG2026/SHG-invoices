/**
 * "Is this the same one under a different name?"
 *
 * ---------------------------------------------------------------------------
 * What this is for, and what already covers the rest
 *
 * `suppliers_name_ci` and `customers_name_ci` are unique indexes on the active
 * rows, so the SAME name typed twice is refused by the database. That is the
 * whole of the protection, and it only catches character-for-character
 * repeats. It does nothing about the case that actually happens:
 *
 *   *"there is a supplier by the name Global Foods Department and a manager
 *   enters it as its full name. but another manager has been entering it as
 *   GFD."*
 *
 * Two rows, two spellings, two sets of totals, and nobody finds out until
 * somebody notices the same delivery twice under two names.
 *
 * The add-invoice sheet does not need this. Its type-ahead already puts the
 * closest existing suppliers directly above `+ Add "X" as a new supplier`, and
 * `rankSuppliers` scores a subsequence — so typing "gfd" surfaces "Global
 * Foods Department" before the Add row is even reachable. **The picker is the
 * duplicate check on that path.** This is for the other path: the plain name
 * field on the Suppliers and Customers screens, where nothing was looking.
 *
 * ---------------------------------------------------------------------------
 * A warning, never a block. Spec §6.
 *
 * "Global Foods Group" and "Global Foods Pty Ltd" can genuinely be two
 * businesses, and a rule that refused the second one would be wrong in a way
 * the person could not get past. So this returns what it found and the screen
 * asks. The cost of a false positive is one dialog; the cost of a false
 * negative is a merge, later, by hand.
 *
 * Pure, so the whole table of cases can be tested without a browser.
 * ---------------------------------------------------------------------------
 */

/**
 * Words that say what KIND of company something is rather than which one.
 *
 * Dropped before comparing, which is what makes "Global Foods Pty Ltd" and
 * "Global Foods" read as the same business. It also means "Global Foods Pty
 * Ltd" and "Global Foods Group" collide — correctly, for a warning: those are
 * far more often one supplier than two.
 */
const NOISE = new Set([
  'pty',
  'ltd',
  'limited',
  'inc',
  'incorporated',
  'co',
  'company',
  'corp',
  'corporation',
  'group',
  'holdings',
  'trading',
  'the',
  'and',
]);

/** Lower case, no punctuation, no company noise, single spaces. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '' && !NOISE.has(word))
    .join(' ');
}

/** "global foods department" → "gfd". Empty for a single word. */
function initials(normalised: string): string {
  const words = normalised.split(' ').filter(Boolean);
  if (words.length < 2) return '';
  return words.map((word) => word[0]).join('');
}

/**
 * Levenshtein, capped.
 *
 * Only ever asked whether the distance is within 1 or 2, so it stops as soon
 * as it cannot be — which keeps this linear in practice over a supplier list
 * that is read on every keystroke of nothing at all. Written out rather than
 * imported: rule 7 says no libraries for this kind of thing, and it is
 * fifteen lines.
 */
function withinDistance(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  if (a === b) return true;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
      current[j] = value;
      if (value < best) best = value;
    }
    // Every route through this row is already too far. Nothing below improves.
    if (best > limit) return false;
    previous = current;
  }

  return previous[b.length]! <= limit;
}

/** Why two names were thought to be the same one. Shown to the person. */
export type NearMatchReason =
  | 'same'
  | 'initials'
  | 'contains'
  | 'spelling';

export interface NearMatch<T> {
  entry: T;
  reason: NearMatchReason;
}

/** The sentence the dialog puts under a matched name. */
export function nearMatchWording(reason: NearMatchReason): string {
  switch (reason) {
    case 'same':
      return 'the same name, written differently';
    case 'initials':
      return 'the same initials';
    case 'contains':
      return 'the same name, with more or less of it';
    case 'spelling':
      return 'one or two letters different';
  }
}

/**
 * Existing entries that look like they are already the thing being added.
 *
 * Ordered by how sure it is, because the first one shown is the one that gets
 * read. Deactivated entries are included by whoever passes them in: on both
 * screens they are, because "you deactivated this one last month" is exactly
 * the thing somebody needs to be told before making a second copy of it.
 */
export function findNearMatches<T extends { name: string }>(
  existing: readonly T[],
  candidate: string,
  limit = 4,
): NearMatch<T>[] {
  const target = normaliseName(candidate);
  // One or two characters is not enough to be wrong about.
  if (target.length < 2) return [];

  const targetInitials = initials(target);
  const targetCompact = target.replace(/ /g, '');

  const found: NearMatch<T>[] = [];

  for (const entry of existing) {
    const other = normaliseName(entry.name);
    if (other.length < 2) continue;

    // Character-for-character identical is not interesting: the database
    // refuses it, so nothing can be added that would hit this. Identical only
    // AFTER normalising is the whole point.
    if (other === target) {
      if (entry.name.trim().toLowerCase() !== candidate.trim().toLowerCase()) {
        found.push({ entry, reason: 'same' });
      }
      continue;
    }

    const otherInitials = initials(other);
    const otherCompact = other.replace(/ /g, '');

    if (
      (targetInitials !== '' && targetInitials === otherCompact) ||
      (otherInitials !== '' && otherInitials === targetCompact)
    ) {
      found.push({ entry, reason: 'initials' });
      continue;
    }

    // Whole words only, so "foods" does not match "seafoods".
    if (startsWithWords(other, target) || startsWithWords(target, other)) {
      found.push({ entry, reason: 'contains' });
      continue;
    }

    // A typo, not a shortening — so only between names of a similar length,
    // and never on short ones where two letters is most of the word.
    const shortest = Math.min(target.length, other.length);
    if (shortest >= 5 && withinDistance(target, other, shortest >= 8 ? 2 : 1)) {
      found.push({ entry, reason: 'spelling' });
    }
  }

  const order: Record<NearMatchReason, number> = {
    same: 0,
    initials: 1,
    contains: 2,
    spelling: 3,
  };

  return found
    .sort((a, b) => order[a.reason] - order[b.reason] || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}

/** Whether `longer` begins with every word of `shorter`, in order. */
function startsWithWords(longer: string, shorter: string): boolean {
  if (longer.length <= shorter.length) return false;
  return longer === shorter || longer.startsWith(`${shorter} `);
}
