'use client';

import { createContext, useContext, useMemo } from 'react';
import { brandPath, useBrandAssets, type BrandKind } from '@/lib/queries/brand';

/**
 * Uploaded artwork, made available to the two leaf components that draw it.
 *
 * ---------------------------------------------------------------------------
 * A context rather than a hook in each component
 *
 * `BusinessMark` and `PersonChip` are rendered dozens of times per screen and
 * in every component test in the suite. Calling a query hook inside them would
 * mean every one of those tests needs a QueryClient to render a 24px square —
 * and it would couple the smallest components in the app to the data layer.
 *
 * The default value is an empty map, so a chip rendered with no provider above
 * it falls back to exactly what it drew before: the bundled file, then the
 * initials. That is the correct degradation and not an accident of testing —
 * it is also what happens on a phone before the bucket has loaded, and before
 * `CATCH_UP_007.sql` has been run at all.
 * ---------------------------------------------------------------------------
 */
const BrandAssetsContext = createContext<Record<string, string>>({});

export function BrandAssetsProvider({ children }: { children: React.ReactNode }) {
  const { data } = useBrandAssets();
  const assets = useMemo(() => data ?? {}, [data]);

  return <BrandAssetsContext.Provider value={assets}>{children}</BrandAssetsContext.Provider>;
}

/**
 * The uploaded picture for a business code or a person's name, or null.
 *
 * Null is the ordinary answer, not a failure: it means nobody has uploaded one
 * and the caller should use whatever it used before.
 */
export function useBrandAsset(kind: BrandKind, key: string | undefined): string | null {
  const assets = useContext(BrandAssetsContext);
  if (!key) return null;
  return assets[brandPath(kind, key)] ?? null;
}
