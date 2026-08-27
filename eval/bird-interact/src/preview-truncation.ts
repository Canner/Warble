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

/**
 * The cut for SQL, which is recorded to be REPLAYED rather than glanced at.
 *
 * A preview of an observation is still useful; a prefix of a statement is not. Wren expands one
 * page of semantic SQL into several thousand characters of nested projections, so `PREVIEW_LIMIT`
 * cut a routine plan rather than an exceptional one — and every consumer downstream then had to
 * decline: the autopsy withheld the task, the report suppressed its ambiguity grades, and the page
 * printed a note where the plan should have been. The measurement was being lost to the record
 * format, not to anything the agent did. The statements are kept whole instead, and this cap
 * remains only as a bound against a pathological input: it is more than an order of magnitude
 * above the largest plan this adapter has recorded, so `looksSqlTruncated` is now the exceptional
 * case it always read as, and the machinery that answers it stays as the backstop.
 */
export const SQL_RECORD_LIMIT = 100_000;

/**
 * Whether recorded text reaches its cut, and so may be a prefix of what really ran.
 *
 * The limit is a parameter because there are two of them and the wrong one gives the wrong answer
 * in BOTH directions: asking `PREVIEW_LIMIT` about a whole 3,000-character plan reports a
 * truncation that did not happen, and asking `SQL_RECORD_LIMIT` about a cut observation misses one
 * that did.
 */
export function looksTruncated(text: string, limit: number = PREVIEW_LIMIT): boolean {
  return text.length >= limit;
}

/** The same question for a recorded statement, which is cut at `SQL_RECORD_LIMIT`. */
export function looksSqlTruncated(sql: string): boolean {
  return looksTruncated(sql, SQL_RECORD_LIMIT);
}
