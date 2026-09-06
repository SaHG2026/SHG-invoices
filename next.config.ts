import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * Which build is this.
 *
 * Added after a deploy silently did not reach `shg-invoices.vercel.app`, and
 * two rounds of "it still says the old thing" were spent before anybody
 * checked. The site was a commit behind; nothing on any screen said so, and
 * the only way I found it was fetching the stylesheet and comparing a border
 * radius.
 *
 * So the app carries its own build id and Settings shows it. "Is what I am
 * looking at the thing I just built" stops being an investigation.
 *
 * `new Date()` is not used, and `toISOString()` is banned outright — HANDOFF
 * §4 rule 2. This is build tooling rather than application code, so the rule
 * does not strictly reach it, but a timestamp here would be one more place
 * somebody has to check. `Date.now()` in base 36 is an opaque label that is
 * never parsed, compared or displayed as a time.
 */
function buildStamp(): string {
  // Vercel sets this whenever it has git metadata, CLI deploys included.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);

  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // No git in the build sandbox. Still answers the only question asked of it.
    return `b${Date.now().toString(36)}`;
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  env: {
    NEXT_PUBLIC_BUILD_STAMP: buildStamp(),
  },
};

export default nextConfig;
