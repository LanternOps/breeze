/**
 * Zod issue flattening for user- and model-facing validation errors.
 *
 * A Zod `union` that fails reports ONE issue: `{ code: 'invalid_union',
 * message: 'Invalid input' }`, with the per-option sub-issues tucked away in
 * `issue.errors` (an array of issue arrays, one per union member). Anything
 * that renders `issues[0].message` — the web client's extractApiError, the AI
 * tool's error string — therefore shows a bare "Invalid input" and the caller
 * has no idea which field or value was wrong.
 *
 * `flattenZodIssues` replaces each `invalid_union` with the sub-issues of the
 * option the payload most nearly matched, re-rooted onto the union's own path
 * so the reported path is absolute (e.g. `items.0.conditions.0.metric`).
 *
 * Used by the configuration-policy feature-link HTTP routes and the
 * `manage_policy_feature_link` AI tool — the two surfaces that validate
 * alert-rule condition payloads, whose conditions are a union several levels
 * deep inside `items[]`.
 */

/** Structural shape of a Zod 4 issue; avoids depending on zod's internal types. */
export type ZodIssueLike = {
  code?: string;
  path?: ReadonlyArray<PropertyKey>;
  message?: string;
  /** Present on `invalid_union`: one sub-issue array per union option. */
  errors?: ReadonlyArray<ReadonlyArray<ZodIssueLike>>;
};

export type FlatZodIssue = ZodIssueLike & { path: PropertyKey[]; message: string };

/**
 * Zod's placeholder message when it has nothing specific to say. Anything else
 * — including "Invalid input: expected number, received string" — names the
 * actual problem and is preferred.
 */
const GENERIC_MESSAGE = 'Invalid input';

function isGeneric(issue: ZodIssueLike): boolean {
  return (issue.message ?? '').trim() === GENERIC_MESSAGE;
}

function maxPathDepth(issues: readonly ZodIssueLike[]): number {
  return issues.reduce((deepest, i) => Math.max(deepest, i.path?.length ?? 0), 0);
}

/**
 * Rank two candidate option groups; returns true when `a` is the better
 * explanation of the failure.
 *
 * 1. Fewest issues wins — the option with one complaint matched the payload's
 *    shape and disagreed about one field; the option with four is a different
 *    shape entirely and its complaints are noise.
 * 2. Then deepest path — a nested, specific field beats a top-level one.
 * 3. Then a non-generic message beats "Invalid input".
 */
function isBetterGroup(a: readonly ZodIssueLike[], b: readonly ZodIssueLike[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  const depthA = maxPathDepth(a);
  const depthB = maxPathDepth(b);
  if (depthA !== depthB) return depthA > depthB;
  return a.every((i) => !isGeneric(i)) && b.some(isGeneric);
}

/**
 * Flatten `invalid_union` issues into the concrete sub-issues they hide.
 * Non-union issues pass through unchanged. Recurses, so a union nested inside
 * a union member is flattened too.
 */
export function flattenZodIssues(issues: readonly ZodIssueLike[]): FlatZodIssue[] {
  const out: FlatZodIssue[] = [];
  for (const issue of issues) {
    const prefix = [...(issue.path ?? [])];
    const groups = (issue.code === 'invalid_union' && Array.isArray(issue.errors) ? issue.errors : [])
      .map((group) => flattenZodIssues(group ?? []))
      .filter((group) => group.length > 0);

    if (groups.length === 0) {
      // Not a union, or a DISCRIMINATED union whose discriminator matched no
      // option — the latter carries an empty `errors` but a message that names
      // every accepted value, which is exactly what we want to surface.
      out.push({ ...issue, path: prefix, message: issue.message ?? GENERIC_MESSAGE });
      continue;
    }

    const best = groups.reduce((winner, group) => (isBetterGroup(group, winner) ? group : winner));
    for (const sub of best) {
      out.push({ ...sub, path: [...prefix, ...sub.path] });
    }
  }
  return out;
}

/** `path` rendered the way callers read it: `items.0.conditions.0.metric`. */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => String(segment)).join('.');
}

/**
 * A `{ formErrors, fieldErrors }` payload in the same shape as
 * `ZodError.flatten()`, but built from FLATTENED issues and keyed by the full
 * dotted path rather than only the first path segment. `flatten()` buckets
 * everything nested under `items` into `fieldErrors.items`, which for an
 * alert-rule payload means every message reads "Invalid input".
 */
export function flattenedZodDetails(issues: readonly FlatZodIssue[]): {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
} {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    if (issue.path.length === 0) {
      formErrors.push(issue.message);
      continue;
    }
    const key = formatIssuePath(issue.path);
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { formErrors, fieldErrors };
}

/**
 * Build the JSON body every feature-link validation 400 returns. `issues` and
 * `details` are both derived from the flattened set so the web client renders
 * the specific message whichever of the two it happens to read first.
 */
export function zodValidationErrorBody(
  label: string,
  error: { issues: readonly ZodIssueLike[] }
): { error: string; details: ReturnType<typeof flattenedZodDetails>; issues: FlatZodIssue[] } {
  const issues = flattenZodIssues(error.issues);
  return { error: label, details: flattenedZodDetails(issues), issues };
}

/**
 * One-line description of the first (most specific) issue, prefixed with its
 * path. Used by the AI tool surface, which returns a single error string.
 */
export function describeFirstZodIssue(error: { issues: readonly ZodIssueLike[] }): string | null {
  const [first] = flattenZodIssues(error.issues);
  if (!first) return null;
  const path = first.path.length > 0 ? `${formatIssuePath(first.path)}: ` : '';
  return `${path}${first.message}`;
}
