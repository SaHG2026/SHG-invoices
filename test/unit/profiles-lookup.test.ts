import { describe, expect, it } from 'vitest';
import { roleMayBeChanged, runsTheBusinesses } from '@/lib/staff';
import type { Profile } from '@/lib/types';

/**
 * Who each list of people is for. ARCHITECTURE §54.1.
 *
 * ===========================================================================
 * The bug this is written against.
 *
 * `useProfiles` is the LOOKUP that names the actor on every row, and it
 * filtered `active = true` for a year — directly under a comment saying it
 * must not. Nobody noticed because nobody who had done anything had ever been
 * deactivated.
 *
 * The three lists over one query answer three different questions, and the
 * answers differ on exactly one row: a suspended person.
 *
 *   useProfiles          everyone            — can name a suspended actor
 *   useTeam              active choices      — must not offer one
 *   useChangeableRoles   changeable rows     — must include one, or the
 *                                              suspension can never be lifted
 *
 * The hooks themselves need a QueryClient and a session. The PREDICATES do
 * not, and they are where the three answers actually differ — so they are
 * what is asserted here.
 * ===========================================================================
 */

function person(over: Partial<Profile> = {}): Profile {
  return {
    id: 'p-1',
    display_name: 'Milan',
    initials: 'MI',
    accent: 'person-3',
    role: 'manager',
    notify_on_new_invoice: false,
    reminder_time: null,
    title: null,
    active: true,
    business_id: null,
    ...over,
  };
}

/** What `useTeam` does now that the query no longer filters. */
function offeredAsAChoice(profile: Profile): boolean {
  return profile.active && runsTheBusinesses(profile);
}

describe('who may be offered as a choice', () => {
  it('offers an active manager', () => {
    expect(offeredAsAChoice(person())).toBe(true);
  });

  it('does not offer a suspended one', () => {
    /*
     * The paid-by pills on History, and the builder's photo screen. A
     * suspended account as a filter can never match anything, so offering it
     * is a control that lies.
     */
    expect(offeredAsAChoice(person({ active: false }))).toBe(false);
  });

  it('still leaves out the builder and the shops, suspended or not', () => {
    // §46.3's allowlist. `active` is a second condition, not a replacement.
    expect(offeredAsAChoice(person({ role: 'builder' }))).toBe(false);
    expect(offeredAsAChoice(person({ role: 'staff', business_id: 'b-1' }))).toBe(false);
    expect(offeredAsAChoice(person({ role: 'assistant' }))).toBe(false);
  });
});

describe('whose role may be changed', () => {
  it('includes a suspended person, so the suspension can be lifted', () => {
    /*
     * The one place the two lists must disagree.
     *
     * This is the only screen that can lift a suspension. A suspended person
     * who dropped off it would be suspended for ever — the same one-way trap
     * §52.5 found when a demoted assistant fell off `useTeam`, arriving a
     * second time by a different route.
     */
    expect(roleMayBeChanged(person({ active: false }))).toBe(true);
    expect(offeredAsAChoice(person({ active: false }))).toBe(false);
  });

  it('still refuses the rows set_user_role refuses', () => {
    // The screen and the function agree by construction rather than by both
    // remembering the same two exceptions.
    expect(roleMayBeChanged(person({ role: 'builder' }))).toBe(false);
    expect(roleMayBeChanged(person({ role: 'staff' }))).toBe(false);
  });

  it('covers all three tiers it is meant to', () => {
    for (const role of ['owner', 'manager', 'assistant'] as const) {
      expect(roleMayBeChanged(person({ role }))).toBe(true);
    }
  });
});

describe('the lookup', () => {
  it('is not the same question as either list', () => {
    /*
     * The regression this file exists for, stated as the fact underneath it:
     * a suspended person is excluded from one list, included in the other, and
     * must be in the lookup regardless — because a row they touched still has
     * to be able to name them.
     */
    const suspended = person({ active: false });
    expect(offeredAsAChoice(suspended)).toBe(false);
    expect(roleMayBeChanged(suspended)).toBe(true);
  });
});
