import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import type { Profile } from '@/lib/types';

/**
 * Logos and photographs, changed from the app.
 *
 * The client's ask was one sentence — "that way I wont have to call up on you
 * each time they have any updates on logo" — so the thing worth testing is not
 * that a file uploads. It is that this screen never claims to do something it
 * cannot, and never offers a control to somebody it will refuse.
 */

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  /* Who is signed in, and which pictures already exist. Driven per test. */
  role: { current: 'builder' as string },
  assets: { current: {} as Record<string, string> },
}));

const signedIn = (): Profile =>
  ({ ...PROFILES[3]!, role: mocks.role.current }) as unknown as Profile;

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: signedIn(), isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: makeInvoices(10), isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/detail', () => ({ useRecentActivity: () => ({ data: [] }) }));

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/brand', async (importOriginal) => {
  // `brandPath` is the real one: it decides where a picture is stored, and a
  // stub of it here would let the screen and the bucket disagree about that
  // without a test noticing.
  const actual = await importOriginal<typeof import('@/lib/queries/brand')>();
  return {
    ...actual,
    useBrandAssets: () => ({ data: mocks.assets.current }),
    useUploadBrandAsset: () => ({ mutateAsync: mocks.upload, isPending: false }),
    useRemoveBrandAsset: () => ({ mutateAsync: mocks.remove, isPending: false }),
  };
});

vi.mock('next/navigation', () => ({ usePathname: () => '/brand' }));

const { BrandScreen } = await import('@/components/screens/BrandScreen');
const { BrandAssetsProvider } = await import('@/lib/brand/context');
const { brandPath } = await import('@/lib/queries/brand');

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.role.current = 'builder';
  mocks.assets.current = {};
  mocks.upload.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
});

function open() {
  return render(
    <ToastProvider>
      <BrandAssetsProvider>
        <BrandScreen />
      </BrandAssetsProvider>
    </ToastProvider>,
  );
}

const image = (name = 'logo.png', type = 'image/png', size = 1000) => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

function choose(forName: string, file: File) {
  const input = screen.getByLabelText(`Choose a picture for ${forName}`);
  fireEvent.change(input, { target: { files: [file] } });
}

describe('where a picture is stored', () => {
  it('is decided by the name, lower-cased, with no extension', () => {
    // Deterministic, so replacing a picture overwrites rather than accumulating
    // a second file the app will never look at.
    expect(brandPath('businesses', 'GMH')).toBe('businesses/gmh');
    expect(brandPath('people', 'Rabindra')).toBe('people/rabindra');
    expect(brandPath('people', '  Mani ')).toBe('people/mani');
  });
});

describe('the pictures screen', () => {
  it('lists every business and the three people who use the app', () => {
    open();
    for (const business of BUSINESSES) {
      expect(screen.getByText(business.name)).toBeInTheDocument();
    }
    for (const person of PROFILES.filter((p) => p.role !== 'builder')) {
      expect(screen.getByText(person.display_name)).toBeInTheDocument();
    }
  });

  it('does not list the builder, who has no photograph by choice', () => {
    // ARCHITECTURE §30.1: a shadow operator, not one of the four names.
    open();
    expect(screen.queryByText('Rabindra')).not.toBeInTheDocument();
  });

  /**
   * The honest bit. The Home Screen tile is read by the phone before the app
   * has loaded, so it is part of the build and cannot be changed from here.
   * Saying so is the difference between a limitation and a bug report.
   */
  it('says plainly that the app icon is not one of these', () => {
    open();
    expect(screen.getByText(/Home Screen/)).toBeInTheDocument();
  });

  it('offers Add where there is no picture yet', () => {
    open();
    expect(screen.getAllByRole('button', { name: 'Add' }).length).toBeGreaterThan(0);
  });

  it('offers Replace and Remove where there is one', () => {
    mocks.assets.current = { 'businesses/gmh': 'https://example.test/businesses/gmh?v=1' };
    open();
    expect(screen.getAllByRole('button', { name: 'Replace' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
  });

  it('sends the business code, not the business name', () => {
    open();
    choose('GroceryMate Hurstville', image());

    return waitFor(() => {
      expect(mocks.upload).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'businesses', key: 'GMH' }),
      );
    });
  });

  it('sends a person by name', () => {
    open();
    choose('Mani', image('face.jpg', 'image/jpeg'));

    return waitFor(() => {
      expect(mocks.upload).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'people', key: 'Mani' }),
      );
    });
  });
});

describe('what it refuses, before the upload does', () => {
  /*
   * Both of these would be refused by storage anyway, and the refusal would
   * arrive as an error code in front of somebody holding a photograph that
   * looked perfectly fine to them. Saying it here says it in their words.
   */
  it('will not take something that is not an image', async () => {
    open();
    choose('Mani', new File(['x'], 'accounts.pdf', { type: 'application/pdf' }));

    expect(await screen.findByText(/not an image file/)).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('will not take a picture over 2MB, and says why in a useful way', async () => {
    open();
    choose('Mani', image('huge.png', 'image/png', 5_000_000));

    expect(await screen.findByText(/bigger than 2MB/)).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('says what went wrong when the upload is refused', async () => {
    mocks.upload.mockRejectedValue(new Error('new row violates row-level security policy'));
    open();
    choose('Mani', image());

    expect(await screen.findByText(/row-level security/)).toBeInTheDocument();
  });
});

describe('who may change one', () => {
  /**
   * The screen is reachable by anybody who types the url, so the controls are
   * gated here as well as in the storage policy. Not instead of: the policy in
   * CATCH_UP_007 is what actually enforces it, and this only avoids offering a
   * button that would fail.
   */
  it('gives a member no buttons', () => {
    mocks.role.current = 'member';
    open();

    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.getByText(/set by whoever maintains the app/)).toBeInTheDocument();
  });

  it('gives the owner no buttons either', () => {
    /*
     * The correction in CATCH_UP_008, and the reason it is worth a test of its
     * own: the first version let the owner edit, on the reasoning that nobody
     * should have to wait on one person. The client's ruling is that Mani's
     * authority is over the money, not over the app — "the three users are
     * only users with mani having slight higher authority".
     *
     * The storage policy is what actually enforces this. The screen only
     * avoids offering a button that would be refused.
     */
    mocks.role.current = 'owner';
    open();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('gives the builder the buttons', () => {
    mocks.role.current = 'builder';
    open();
    expect(screen.getAllByRole('button', { name: 'Add' }).length).toBeGreaterThan(0);
  });
});

describe('putting one back', () => {
  it('removes the uploaded picture so the original returns', async () => {
    mocks.assets.current = { 'people/mani': 'https://example.test/people/mani?v=1' };
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith({ kind: 'people', key: 'Mani' }),
    );
    expect(await screen.findByText(/put back to the original/)).toBeInTheDocument();
  });
});

describe('nothing broken — notes §6', () => {
  it('has no leaked placeholders', () => {
    mocks.assets.current = { 'businesses/gmh': 'https://example.test/businesses/gmh?v=1' };
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]']) {
      expect(text, `"${token}" leaked into the pictures screen`).not.toContain(token);
    }
  });
});
