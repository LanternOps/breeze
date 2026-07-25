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
 * as its `joinZodFlatten` helper so the two render identically and dedupe
 * into a single toast line (pinned by a contract test in apiError.test.ts).
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

/**
 * Mirrors Hono's own `jsonRegex` (hono/validator) so this middleware engages on
 * exactly the requests the json validator would try to parse — no more, no less.
 */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/**
 * Makes a JSON request body genuinely optional for `zValidator('json', …)`.
 *
 * Hono's json validator skips parsing entirely when there is no json
 * content-type (leaving the validated value as `{}`), but if the content-type
 * IS json it calls `c.req.json()` unconditionally — and `JSON.parse('')` throws,
 * which Hono turns into a 400 `Malformed JSON in request body`.
 *
 * That combination bites any route whose body is optional, because the web
 * client's `fetchWithAuth` (apps/web/src/stores/auth.ts) sets
 * `Content-Type: application/json` on every non-FormData request — including
 * ones sent with no body at all. Such a caller looks bodyless at the call site
 * but arrives as "json content-type + empty body", i.e. the one shape that 400s.
 * Routes that previously hand-rolled `await c.req.json().catch(() => ({}))`
 * swallowed this; moving them onto `zValidator` reintroduces it (#2777).
 *
 * Mount this immediately before the json `zValidator` on any route whose body
 * is optional. An empty (or whitespace-only) body is normalised to `{}` so the
 * schema's own defaults/optionals apply; a non-empty body is left completely
 * untouched, so genuinely malformed JSON still 400s as it should.
 */
export function optionalJsonBody(): MiddlewareHandler {
  return async (c, next) => {
    const contentType = c.req.header('content-type');
    if (contentType && JSON_CONTENT_TYPE.test(contentType)) {
      // Hono implements `json()` as `text().then(JSON.parse)` and memoises the
      // text in `bodyCache`, so reading it here costs nothing extra downstream:
      // the validator reuses this exact promise instead of re-reading the
      // stream. `bodyCache.text` is typed as `string` but always holds a
      // `Promise<string>` at runtime (Hono assigns `raw.text()` to it), hence
      // the cast.
      const text = await c.req.text();
      if (text.trim() === '') {
        c.req.bodyCache.text = Promise.resolve('{}') as unknown as string;
      }
    }
    await next();
  };
}

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
  errors?: ReadonlyArray<ReadonlyArray<ZodIssueLike>>;
};

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
    if (!bucket.includes(issue.message)) bucket.push(issue.message);
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
