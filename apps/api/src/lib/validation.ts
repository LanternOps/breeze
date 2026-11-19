/**
 * Shared zValidator wrapper — readable validation 400s (issue #2201).
 *
 * `@hono/zod-validator`'s default 400 hook returns the raw safeParse result,
 * so the wire body is `{success:false, error:{name:"ZodError", message:"..."}}`.
 * Under zod v4 `ZodError.issues` is non-enumerable, so JSON serialization
 * buries the issues inside `error.message` as a stringified array — unreadable
 * for every consumer that expects `error` to be a string (mobile, MCP clients,
 * scripts, portal).
 *
 * This wrapper installs a default hook that emits a stable, string-first
 * contract instead:
 *
 * ```json
 * {
 *   "error": "Unrecognized key: \"maxUses\"; contacts.0.email: Invalid email",
 *   "details": {
 *     "formErrors": ["Unrecognized key: \"maxUses\""],
 *     "fieldErrors": { "contacts.0.email": ["Invalid email"] }
 *   }
 * }
 * ```
 *
 * The web client's `extractApiError` (apps/web/src/lib/apiError.ts) already
 * understands both `{error: string}` and the flattened `details` shape — the
 * `error` string here is built with the same ordering and `'; '` join rules
 * as its `joinZodFlatten(details, rawPaths)` helper, which is how the web
 * recognises it and renders the details once with readable field labels
 * instead of these dotted paths (#8369). Keep the two in step: the exact body
 * `formatZodError` emits for the multi-field case in validation.test.ts is
 * replayed verbatim by a contract test in apps/web/src/lib/apiError.test.ts.
 *
 * Route files must import `zValidator` from this module, not from
 * `@hono/zod-validator` directly (guarded by validation.imports.test.ts).
 * A per-route custom hook can still be passed as the third argument; a
 * returned `Response` — or the base package's `{response: Response}` return
 * shape — wins, otherwise validation failures fall through to the readable
 * default above (previously a non-returning hook fell through to the raw
 * ZodError body).
 */
import { zValidator as baseZValidator } from '@hono/zod-validator';
import type { Hook } from '@hono/zod-validator';
import type { Context, Env, MiddlewareHandler, ValidationTargets } from 'hono';
import type { z } from 'zod';

export type ValidationErrorBody = {
  error: string;
  details: {
    formErrors: string[];
    fieldErrors: Record<string, string[]>;
  };
};

/**
 * Minimal structural view of a ZodError that works across zod v3/v4 types
 * (v4 `issue.path` is `ReadonlyArray<PropertyKey>` and may contain symbols).
 */
type ZodIssueLike = {
  path: ReadonlyArray<PropertyKey>;
  message: string;
  code?: string;
  format?: string;
  errors?: ReadonlyArray<ReadonlyArray<ZodIssueLike>>;
};

/**
 * zod v4's default message for a `.regex()` declared without one is
 * "Invalid string: must match pattern /^…$/" — the raw pattern is an
 * implementation detail, not user copy, and dozens of schemas still omit the
 * message. Scrub it here, at the single 400 choke point, so no regex reaches
 * a user (#8369). An explicit `.regex(re, 'message')` is passed through as-is.
 * zod v4 only: v3 issues carry no `format`, so they pass through unchanged.
 */
const DEFAULT_REGEX_MESSAGE_PREFIX = 'Invalid string: must match pattern';

function userFacingMessage(issue: ZodIssueLike): string {
  if (
    issue.code === 'invalid_format' &&
    issue.format === 'regex' &&
    issue.message.startsWith(DEFAULT_REGEX_MESSAGE_PREFIX)
  ) {
    return 'Invalid format';
  }
  return issue.message;
}

type ZodErrorLike = {
  issues: ReadonlyArray<ZodIssueLike>;
};

function collectIssues(
  issues: ReadonlyArray<ZodIssueLike>,
  basePath: ReadonlyArray<PropertyKey>,
  formErrors: string[],
  fieldErrors: Record<string, string[]>
): void {
  for (const issue of issues) {
    const fullPath = [...basePath, ...issue.path];

    // zod v4 buries each union branch's real failures in a nested `errors`
    // array-of-arrays while the union issue's own message is just "Invalid
    // input" — recurse so union-heavy schemas still surface actionable
    // per-field messages. Branches often fail identically, so duplicates are
    // collapsed per bucket.
    if (issue.code === 'invalid_union' && Array.isArray(issue.errors) && issue.errors.length > 0) {
      for (const branch of issue.errors) {
        collectIssues(branch, fullPath, formErrors, fieldErrors);
      }
      continue;
    }

    const path = fullPath.map((segment) => String(segment)).join('.');
    const bucket = path ? (fieldErrors[path] ??= []) : formErrors;
    const message = userFacingMessage(issue);
    if (!bucket.includes(message)) bucket.push(message);
  }
}

export function formatZodError(error: ZodErrorLike): ValidationErrorBody {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};

  collectIssues(error.issues, [], formErrors, fieldErrors);

  const parts = [
    ...formErrors,
    ...Object.entries(fieldErrors).map(
      ([field, messages]) => `${field}: ${messages.join('; ')}`
    ),
  ];

  return {
    error: parts.length > 0 ? parts.join('; ') : 'Validation failed',
    details: { formErrors, fieldErrors },
  };
}

/**
 * Does this Content-Type name a JSON body, exactly as Hono's own validator
 * decides it?
 *
 * Copied deliberately from `hono/dist/validator/validator.js` (`jsonRegex` and
 * `getMediaType`, Hono 4.13.18) rather than re-derived. A route that
 * hand-parses its body instead of using {@link zValidator} has to reproduce
 * this verdict or it silently changes what the endpoint accepts — and an
 * approximation gets it wrong in BOTH directions. A hand-rolled
 * `^application\/(\w+\+)?json\b` looks equivalent and is not: `\b` matches
 * before a hyphen so it ACCEPTS `application/json-bogus`, which Hono rejects,
 * and `\w` excludes `.` and `-` so it REJECTS `application/vnd.api+json` and
 * `application/merge-patch+json`, which Hono accepts.
 *
 * Since 4.13.18 (GHSA-92p4-j3wq-jmqx) Hono decides by the MEDIA TYPE ALONE:
 * everything from the first `;` is dropped, the rest is `.trim()`med and
 * lower-cased, and only then matched. The parameter list no longer matters, so
 * `application/json ; charset=utf-8`, `application/json;` and
 * `application/json; odd` are all JSON. `.trim()` is JavaScript's, which strips
 * Unicode whitespace too, so `application/json` followed by a non-breaking
 * space is JSON as well (4.13.14 and earlier rejected it). Keep this in step
 * with Hono, not with HTTP's whitespace rules: `jsonContentType.test.ts` uses
 * Hono as the oracle and fails on any drift it samples.
 */
export const JSON_MEDIA_TYPE_RE = /^application\/([\w.-]+\+)?json$/i;

/** The media type of a Content-Type header, as Hono's validator reads it. */
function mediaTypeOf(header: string): string {
  return header.split(';')[0]!.trim().toLowerCase();
}

/** True when `header` is a JSON media type by Hono's rule. */
export function isJsonContentType(header: string | undefined | null): boolean {
  return header ? JSON_MEDIA_TYPE_RE.test(mediaTypeOf(header)) : false;
}

type ValidatorHook<
  T extends z.ZodType,
  E extends Env,
  P extends string,
  Target extends keyof ValidationTargets,
> = Hook<z.output<T>, E, P, Target, {}, T>;

export const zValidator = <
  T extends z.ZodType,
  Target extends keyof ValidationTargets,
  E extends Env = Env,
  P extends string = string,
>(
  target: Target,
  schema: T,
  hook?: ValidatorHook<T, E, P, Target>
) =>
  baseZValidator<T, Target, E, P, ValidatorHook<T, E, P, Target>>(
    target,
    schema,
    async (
      result: Parameters<ValidatorHook<T, E, P, Target>>[0],
      c: Context<E, P>
    ) => {
      if (hook) {
        const hookResult: unknown = await hook(result, c);
        if (hookResult instanceof Response) return hookResult;
        // Mirror @hono/zod-validator's own semantics: a hook may also return
        // a `{response: Response}` wrapper — dropping it would silently
        // discard the hook's rejection and let the request proceed.
        if (hookResult && typeof hookResult === 'object' && 'response' in hookResult) {
          const wrapped = (hookResult as { response: unknown }).response;
          if (wrapped instanceof Response) return wrapped;
        }
      }
      if (!result.success) {
        return c.json(formatZodError(result.error as ZodErrorLike), 400);
      }
    }
  );

/**
 * `zValidator('json', schema)` for routes whose body is genuinely OPTIONAL.
 *
 * Two behaviours differ from the plain json validator, both of which bit us:
 *
 * 1. **An absent/empty body is `{}`, not a 400.** Hono's json validator calls
 *    `c.req.json()` whenever the Content-Type is JSON and throws
 *    `HTTPException(400, 'Malformed JSON in request body')` when the body is
 *    empty. Plenty of clients POST with no body at all while still sending
 *    `Content-Type: application/json` — the web app's `fetchWithAuth` sets that
 *    header unconditionally (stores/auth.ts), and hand-rolled curl/script
 *    clients do the same. Those callers used to work against a hand-parsed
 *    `c.req.json().catch(() => ({}))` route, and must keep working: the
 *    schema's own `.optional()` fields are what define "no body is fine".
 * 2. **The rejection body is JSON**, matching {@link formatZodError}'s
 *    string-first `{error, details}` contract. `HTTPException`'s response is
 *    `text/plain`, so a client doing `await res.json()` on the failure path
 *    throws a SyntaxError and loses the real reason.
 *
 * Use this only where the body really is optional. A route with required
 * fields should keep `zValidator('json', ...)` so a missing body is reported
 * as the missing-field error it is.
 */
export const optionalJsonValidator = <T extends z.ZodType>(
  schema: T
): MiddlewareHandler<Env, string, { in: { json: z.input<T> }; out: { json: z.output<T> } }> =>
  async (c, next) => {
    const contentType = c.req.header('Content-Type');
    let raw: unknown = {};

    // Mirror Hono's own gate: a non-JSON (or absent) Content-Type means the
    // json target simply isn't populated, rather than being an error.
    // Single definition of the rule: isJsonContentType above.
    if (isJsonContentType(contentType)) {
      const text = await c.req.text();
      if (text.trim() !== '') {
        try {
          raw = JSON.parse(text);
        } catch {
          return c.json(
            {
              error: 'Malformed JSON in request body',
              details: { formErrors: ['Malformed JSON in request body'], fieldErrors: {} },
            } satisfies ValidationErrorBody,
            400
          );
        }
      }
    }

    const result = await schema.safeParseAsync(raw);
    if (!result.success) {
      return c.json(formatZodError(result.error as ZodErrorLike), 400);
    }

    c.req.addValidatedData('json', result.data as Record<string, unknown>);
    await next();
  };
