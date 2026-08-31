'use client';

import { useRef, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { PersonChip } from '@/components/ui/PersonChip';
import { useToast } from '@/components/ui/Toast';
import { useBusinesses } from '@/lib/queries/reference';
import { useCurrentProfile, useTeam } from '@/lib/queries/session';
import { useBrandAsset } from '@/lib/brand/context';
import { useRemoveBrandAsset, useUploadBrandAsset, type BrandKind } from '@/lib/queries/brand';

/**
 * Logos and photographs, changed from the phone rather than from the repo.
 *
 * The client asked for this in one sentence: "grant me a permission to edit and
 * change the pictures/icons from my end that way I wont have to call up on you
 * each time they have any updates on logo". Everything here follows from that
 * being the whole requirement.
 *
 * ---------------------------------------------------------------------------
 * What this screen is honest about
 *
 * **The app's own icon is not here.** The tile on the Home Screen and the one
 * in the browser tab are read by the phone before the app has loaded, so they
 * are part of the build and a new one is still a deployment. Putting them on
 * this screen would be offering something that quietly does not work, which is
 * the failure this app tries hardest to avoid.
 *
 * **A picture is replaced, never versioned.** Uploading writes over the same
 * path, so there is no history and no undo — which is why Remove exists and
 * why the copy says what will come back when you use it. Nothing here is
 * subject to rule 5: a logo is not a record of anything.
 * ---------------------------------------------------------------------------
 */
export function BrandScreen() {
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();
  // The three people who run the businesses. The builder is not one of them
  // and has no photograph by choice — ARCHITECTURE §30.1.
  const { data: people = [] } = useTeam();

  /*
   * The builder, and nobody else.
   *
   * This said `builder || owner` first, on the reasoning that the point of the
   * feature is nobody waiting on one person. The client corrected it: "mani
   * doesnt get to do any editing stuffs. the three users are only users with
   * mani having slight higher authority."
   *
   * Which is the sharper reading of what `role` has always meant here. Mani's
   * authority is over the money — he is the one told when a bill is paid,
   * and the one whose screen carries the overview. It was never over the app
   * itself, and a logo is part of the app.
   */
  const mayEdit = profile?.role === 'builder';

  return (
    <AppChrome back={{ href: '/settings' as Route, label: 'Settings' }}>
      <h1 className="text-h1 mb-1 text-ink">Pictures</h1>
      <p className="mb-5 text-sm text-muted">
        {mayEdit
          ? 'Changes appear for everybody the next time they open the app.'
          : 'These are set by whoever maintains the app.'}
      </p>

      <section className="mb-5">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">Businesses</p>
        <div className="rounded-sm border border-edge bg-card">
          {businesses.map((business) => (
            <Row
              key={business.id}
              kind="businesses"
              assetKey={business.code}
              name={business.name}
              mayEdit={mayEdit}
              preview={<BusinessMark business={business} />}
            />
          ))}
        </div>
      </section>

      <section>
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">People</p>
        <div className="rounded-sm border border-edge bg-card">
          {people.map((person) => (
            <Row
              key={person.id}
              kind="people"
              assetKey={person.display_name}
              name={person.display_name}
              mayEdit={mayEdit}
              preview={<PersonChip profile={person} />}
            />
          ))}
        </div>
      </section>

      <p className="mt-5 text-sm text-muted">
        The app&rsquo;s own icon &mdash; the one on your Home Screen &mdash; is part of the app
        itself and is not changed here.
      </p>
    </AppChrome>
  );
}

interface RowProps {
  kind: BrandKind;
  /** A business code, or a person's display name. */
  assetKey: string;
  name: string;
  mayEdit: boolean;
  preview: React.ReactNode;
}

function Row({ kind, assetKey, name, mayEdit, preview }: RowProps) {
  const toast = useToast();
  const upload = useUploadBrandAsset();
  const remove = useRemoveBrandAsset();
  const uploaded = useBrandAsset(kind, assetKey);

  /*
   * A hidden file input driven by a button.
   *
   * The native control renders as "Choose file / no file chosen" at a size
   * nothing else on this screen uses, and it cannot be styled. The button is a
   * 44px target like every other one (spec §9).
   */
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function chosen(file: File | undefined) {
    if (!file) return;

    /*
     * Checked here rather than left to the upload to refuse, because the
     * refusal arrives as a storage error code and the person is standing in
     * front of a screen holding a photograph that looked fine to them.
     */
    if (!file.type.startsWith('image/')) {
      toast.show('That is not an image file.', 'problem');
      return;
    }
    if (file.size > 2_000_000) {
      toast.show('That picture is bigger than 2MB. A smaller one will load faster.', 'problem');
      return;
    }

    setBusy(true);
    try {
      await upload.mutateAsync({ kind, key: assetKey, file });
      toast.show(`${name} updated.`);
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : `Couldn’t change the picture for ${name}.`,
        'problem',
      );
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = '';
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await remove.mutateAsync({ kind, key: assetKey });
      toast.show(`${name} put back to the original.`);
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : `Couldn’t remove that picture.`,
        'problem',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-b-0">
      {preview}
      <span className="min-w-0 flex-1 truncate text-base text-ink">{name}</span>

      {mayEdit ? (
        <>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={`Choose a picture for ${name}`}
            onChange={(event) => void chosen(event.target.files?.[0])}
          />

          {uploaded ? (
            <button
              type="button"
              onClick={() => void clear()}
              disabled={busy}
              className="touch shrink-0 px-2 text-sm text-muted"
            >
              Remove
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={busy}
            className="touch shrink-0 rounded-full border border-hairline px-3 text-sm text-ink"
          >
            {busy ? 'Saving…' : uploaded ? 'Replace' : 'Add'}
          </button>
        </>
      ) : null}
    </div>
  );
}
