import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Unmount between tests.
 *
 * Testing Library registers this itself only when Vitest runs with globals
 * enabled, which this project does not. Without it every render stacks up in
 * the same document, and the second test that looks for a button named "1"
 * finds two — so tests fail for a reason that has nothing to do with the code
 * under test, which is the worst kind of red.
 */
afterEach(() => {
  cleanup();
});

/**
 * `scrollIntoView`, which jsdom does not implement at all.
 *
 * Not a shim for missing behaviour — jsdom does no layout, so there is no
 * behaviour to shim (§45). It is here so that a component calling it does not
 * throw, because the alternative is a `typeof` guard in the component:
 * defensive code protecting against a test environment rather than against
 * anything a browser does, which is the tail wagging the dog.
 *
 * Whether the right element is scrolled to has to be measured in a real
 * browser with `getBoundingClientRect`. That is how the case this was added
 * for was found — a blocking error rendering six pixels below the fold, which
 * every passing assertion was blind to.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
