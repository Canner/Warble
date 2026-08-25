/**
 * The one length at which this package cuts recorded strings, and the test for having hit it.
 *
 * `artifacts.ts` writes every trajectory string through `safeText`, which slices to
 * `PREVIEW_LIMIT`. Nothing downstream can tell a cut string from a short one by looking at it, so
 * anything that replays, re-executes or grades recorded text has to treat a string that reaches the
 * limit as a possible prefix rather than as the thing the agent actually wrote: replaying a prefix
 * produces a syntax error that the agent never caused, and grading a prefix reports content past
 * the cut as absent. Erring toward "possibly truncated" costs a measurement; erring the other way
 * publishes a fabricated one.
 *
 * Kept here, in a module that is not a bin entry, so the limit and the test agree everywhere
 * instead of drifting between hand-mirrored copies.
 */
export const PREVIEW_LIMIT = 2_000;

/** Whether recorded text reaches the preview cut, and so may be a prefix of what really ran. */
export function looksTruncated(text: string): boolean {
  return text.length >= PREVIEW_LIMIT;
}
