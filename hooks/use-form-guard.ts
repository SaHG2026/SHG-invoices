'use client';

import { useEffect } from 'react';
import { formGuard } from '@/lib/form-guard';

/**
 * Call this in the root of any component that contains a form.
 *
 * While it is mounted, no query anywhere in the app refetches on window focus
 * or on reconnect — see lib/query-client.ts, which consults the guard rather
 * than each screen remembering to.
 *
 * Notes §1.1: "Don't fix this per-component. Make it structural." The bug shipped
 * three times in the previous app because each fix was local. One line here is
 * the whole contract, and a screen written in six months inherits it.
 */
export function useFormGuard(): void {
  useEffect(() => formGuard.acquire(), []);
}
