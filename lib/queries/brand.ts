'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';

/**
 * Logos and photographs, stored where they can be changed without a deployment.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * `lib/logos.ts` is a hand-edited table of files in the repo, and its own
 * comment argued for that: four pictures that change roughly never do not need
 * a migration. That was right about the pictures and wrong about the people.
 * Every new logo was a message to whoever had the repo and a deployment, and
 * the client asked for it not to be: "that way I wont have to call up on you
 * each time they have any updates on logo".
 *
 * So the registry stays as the fallback and this sits in front of it. Nothing
 * is removed: a business with no uploaded logo still gets the bundled file,
 * and one with neither still gets its letters.
 * ---------------------------------------------------------------------------
 *
 * **Deterministic paths, no table.** A business's logo is always at
 * `businesses/<code>` and a person's at `people/<name>`, both lower-case, with
 * no extension. That means replacing one is an upsert to the same path rather
 * than an insert plus a delete of whatever was there before — so the bucket
 * cannot accumulate orphans, and there is no second table to get out of step
 * with what is actually stored.
 */

const BUCKET = 'brand';

export type BrandKind = 'businesses' | 'people';

/** One picture that exists in the bucket. */
export interface BrandAsset {
  /** `businesses/gmh`, `people/mani`. */
  path: string;
  /**
   * The public url, with the last-modified time on the end.
   *
   * The query string is what makes a replaced picture actually appear.
   * Supabase serves this bucket through a CDN that caches on the url, and the
   * url does not change when the file behind it does — so without this,
   * uploading a new logo changes nothing on anybody's phone until the cache
   * expires, which reads as the upload having silently failed.
   */
  url: string;
}

/** Where a given business or person's picture lives. Lower-case, always. */
export function brandPath(kind: BrandKind, key: string): string {
  return `${kind}/${key.trim().toLowerCase()}`;
}

/**
 * Every uploaded picture, as a map from path to url.
 *
 * One query for the whole app rather than a lookup per chip: there are four
 * businesses and four people, the answer is the same on every screen, and a
 * request per avatar is the thing `lib/logos.ts` was written to avoid.
 */
export function useBrandAssets() {
  return useQuery({
    queryKey: ['brand', 'assets'] as const,
    queryFn: async (): Promise<Record<string, string>> => {
      const client = supabase();

      const folders: BrandKind[] = ['businesses', 'people'];
      const found: Record<string, string> = {};

      for (const folder of folders) {
        const { data, error } = await client.storage.from(BUCKET).list(folder);

        /*
         * A missing bucket is not an error worth surfacing.
         *
         * Until CATCH_UP_007 has been run there is no bucket, and the right
         * behaviour then is exactly the old behaviour: the bundled artwork.
         * Throwing here would take out every screen that shows a chip.
         */
        if (error) return found;

        for (const file of data ?? []) {
          const path = `${folder}/${file.name}`;
          const { data: pub } = client.storage.from(BUCKET).getPublicUrl(path);
          const version = file.updated_at ?? file.created_at ?? '';
          found[path] = version === '' ? pub.publicUrl : `${pub.publicUrl}?v=${Date.parse(version)}`;
        }
      }

      return found;
    },
    // They change roughly never, and a stale one for five minutes is a logo,
    // not a figure. Nothing here can reach a total.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export interface UploadBrandInput {
  kind: BrandKind;
  /** A business code, or a person's display name. */
  key: string;
  file: File;
}

/**
 * Put a picture in, replacing whatever was at that path.
 *
 * Not queued for offline, deliberately — unlike every write in
 * `lib/offline/keys.ts`. A queued file upload means holding the bytes of an
 * image in IndexedDB for up to a week and replaying it against a path that may
 * have been changed twice since. Changing a logo is a deliberate act done
 * sitting down, and telling somebody to try again when they have signal is an
 * honest answer for it.
 */
export function useUploadBrandAsset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ kind, key, file }: UploadBrandInput): Promise<void> => {
      const { error } = await supabase()
        .storage.from(BUCKET)
        .upload(brandPath(kind, key), file, {
          upsert: true,
          contentType: file.type,
          // Long, because the url carries a version and a new upload changes
          // the version. There is nothing to be gained by re-fetching a file
          // whose url only exists while that exact file does.
          cacheControl: '86400',
        });

      if (error) throw error;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['brand', 'assets'] });
    },
  });
}

/** Take a picture back out, so the bundled artwork or the letters return. */
export function useRemoveBrandAsset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ kind, key }: { kind: BrandKind; key: string }): Promise<void> => {
      const { error } = await supabase().storage.from(BUCKET).remove([brandPath(kind, key)]);
      if (error) throw error;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['brand', 'assets'] });
    },
  });
}
