/**
 * Adapting async work to callback slots that expect nothing back.
 *
 * `onClick`, `setTimeout` and friends ignore a returned promise, so an
 * `async` function handed to one directly has nowhere for a rejection to go:
 * it becomes an unhandled rejection, invisible to the person using the app and
 * usually invisible to us too. Every such site goes through here instead, so
 * there is exactly one place that decides what an unexpected failure does.
 *
 * "Unexpected" is the operative word. Failures a call site anticipates — a
 * rejected sign-in, an upload that was cancelled — are caught where they
 * happen and turned into something the interface can show. What reaches this
 * module is a bug, and it says so rather than disappearing.
 */
import { useUi } from '../store/ui.ts';

/** Report a failure that no call site expected. */
function reportUnexpected(err: unknown): void {
  // Never the raw error: it can carry a server message, a URL, or the shape of
  // internal state, none of which belongs in front of a person.
  useUi.getState().toast('Something went wrong', 'danger');

  if (import.meta.env.DEV) {
    // In development the detail is what makes the bug findable.
    console.error('Unhandled failure in an async handler:', err);
  }
}

/**
 * Wrap an async function for a slot that expects a `void` return.
 *
 * @example
 *   <button onClick={onAsync(async () => { await save(); })}>Save</button>
 */
export function onAsync<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
): (...args: A) => void {
  return (...args: A) => {
    fn(...args).catch(reportUnexpected);
  };
}

/**
 * The same adaptation for work started without a callback slot — a promise
 * deliberately left to run on its own.
 */
export function detach(promise: Promise<unknown>): void {
  promise.catch(reportUnexpected);
}
