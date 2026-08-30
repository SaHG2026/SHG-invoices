import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { PersonChip } from '@/components/ui/PersonChip';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { BUSINESS_MARKS, PERSON_PHOTOS, businessMark, personPhoto } from '@/lib/logos';
import { BUSINESSES, PROFILES } from '../fixtures/invoices';

/**
 * Faces and logos.
 *
 * The chip's job is unchanged — spec §9 calls it "the app's only recurring
 * colour-as-identity device". A photograph is simply a faster read than two
 * letters at the same 24px.
 *
 * The test that earns its place is the last block: every path in either
 * registry must point at a file that actually exists. A typo there produces a
 * broken-image icon in the header of every screen, which is both the most
 * visible possible failure and the one no other test would catch.
 */

describe('a person with a photograph', () => {
  it('shows the photograph instead of initials', () => {
    const mani = PROFILES.find((p) => p.display_name === 'Mani')!;
    render(<PersonChip profile={mani} />);

    const image = screen.getByRole('img', { name: 'Mani' });
    expect(image).toHaveAttribute('src', '/people/mani.jpg');
    expect(screen.queryByText(mani.initials)).not.toBeInTheDocument();
  });

  it('keeps the person accent behind it', () => {
    // So a photo that has not loaded yet still shows the colour people
    // already associate with that person, rather than an empty hole.
    const mani = PROFILES.find((p) => p.display_name === 'Mani')!;
    const { container } = render(<PersonChip profile={mani} />);
    expect(container.querySelector('img')!.getAttribute('style')).toContain('--person-2-bg');
  });

  it('is announced by name, not left decorative', () => {
    // The initials it replaces were real text and were read out. On an
    // invoice row the chip is the only thing saying who logged it.
    const sujan = PROFILES.find((p) => p.display_name === 'Sujan')!;
    render(<PersonChip profile={sujan} />);
    expect(screen.getByRole('img', { name: 'Sujan' })).toBeInTheDocument();
  });
});

describe('a person without one', () => {
  it('falls back to initials rather than a broken image', () => {
    const milan = PROFILES.find((p) => p.display_name === 'Milan')!;
    expect(personPhoto('Milan')).toBeNull();

    const { container } = render(<PersonChip profile={milan} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(milan.initials)).toBeInTheDocument();
  });

  it('matches the name whatever its casing or padding', () => {
    expect(personPhoto('  MANI ')).toBe('/people/mani.jpg');
  });
});

describe('business marks', () => {
  it('gives both GroceryMates the one brand', () => {
    expect(businessMark('GMH').src).toBe(businessMark('GMP').src);
  });

  it('letters Deli Delights rather than lending it another brand', () => {
    const ddl = BUSINESSES.find((b) => b.code === 'DDL')!;
    const { container } = render(<BusinessMark business={ddl} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('DD')).toBeInTheDocument();
  });

  it('falls back to the business code when nothing is registered', () => {
    const { container } = render(
      <BusinessMark business={{ code: 'XYZ', name: 'Somewhere New' }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('XYZ')).toBeInTheDocument();
  });
});

describe('every registered file exists', () => {
  /*
   * A typo in either registry renders a broken-image icon in the header of
   * every screen in the app. Nothing else here would notice; the components
   * are perfectly happy to point at a 404.
   */
  const paths = [
    ...Object.values(PERSON_PHOTOS),
    ...Object.values(BUSINESS_MARKS).map((mark) => mark.src),
  ].filter((path): path is string => typeof path === 'string');

  it('has something to check', () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  for (const path of [...new Set(paths)]) {
    it(`public${path} is really there`, () => {
      expect(existsSync(`public${path}`), `public${path} is missing`).toBe(true);
    });
  }
});
