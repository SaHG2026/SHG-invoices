'use client';

/**
 * Getting a generated file onto a phone. ARCHITECTURE §48.2.
 *
 * ===========================================================================
 * The thing that was asked for and cannot be built, stated first
 *
 * The client asked for a Mail button that opens Gmail with the invoice
 * attached. **A web page cannot attach a file to a mail client.** `mailto:`
 * carries a subject and a body and nothing else; that is the URL scheme, not a
 * browser restriction, and no library changes it.
 *
 * `navigator.share({ files })` does exactly what he described: it hands the
 * file to Android, he picks Gmail, and Gmail opens with the attachment already
 * on it. Same three taps, and the phone's own list of apps rather than one we
 * chose for him.
 * ===========================================================================
 */

/**
 * Can this browser share a file at all?
 *
 * Three separate questions, and all three have to be asked. `navigator.share`
 * exists on browsers that cannot take files; `canShare` exists separately; and
 * `canShare({ files })` is the only one that answers the actual question. A
 * button offered on the strength of the first two is a button that throws when
 * pressed, which is notes §6 in its most annoying form.
 *
 * Called with the real file rather than a probe, because Safari's answer
 * depends on the file's type.
 */
export function canShareFile(file: File): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;

  try {
    return nav.canShare({ files: [file] });
  } catch {
    // Some browsers throw rather than returning false for an unsupported type.
    return false;
  }
}

export type ShareOutcome = 'shared' | 'dismissed' | 'unavailable' | 'failed';

/**
 * Hand the file to the phone.
 *
 * **`AbortError` is not a failure and must not be reported as one.** It is
 * what a share sheet returns when somebody opens it and changes their mind,
 * which is an ordinary thing to do — and a toast saying "couldn't share that"
 * every time somebody backs out would train them to distrust the one that
 * means it.
 */
export async function shareFile(file: File, title: string): Promise<ShareOutcome> {
  if (!canShareFile(file)) return 'unavailable';

  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'dismissed';
    return 'failed';
  }
}

/**
 * Save the file to the device.
 *
 * An anchor with `download`, which is the only mechanism there is — and the
 * object URL is revoked afterwards rather than left behind, because this page
 * can be opened and closed many times in a session and each one would pin its
 * blob in memory until the tab was closed.
 *
 * The revoke is deferred by a frame. Revoking synchronously after `click()`
 * races the browser's own fetch of the URL on some Android builds, and the
 * download silently produces a zero-byte file — which looks exactly like a
 * bug in the PDF writer and is not.
 */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
