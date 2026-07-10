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
import type { Context, Env, ValidationTargets } from 'hono';
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
