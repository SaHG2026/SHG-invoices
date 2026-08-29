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
