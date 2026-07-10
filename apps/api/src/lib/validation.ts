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
 *   "error": "name: Required; contacts.0.email: Invalid email",
 *   "details": {
 *     "formErrors": ["Unrecognized key: \"maxUses\""],
 *     "fieldErrors": { "contacts.0.email": ["Invalid email"] }
 *   }
 * }
 * ```
 *
 * The web client's `extractApiError` (apps/web/src/lib/apiError.ts) already
 * understands both `{error: string}` and the flattened `details` shape — the
 * `error` string here is built with the exact join rules of its
 * `joinZodFlatten` helper so the two render identically and dedupe into a
 * single toast line.
 *
 * Route files must import `zValidator` from this module, not from
 * `@hono/zod-validator` directly. A per-route custom hook can still be passed
 * as the third argument; if it returns a Response that wins, otherwise
 * validation failures fall through to the readable default above (previously
 * a non-returning hook fell through to the raw ZodError body).
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
type ZodErrorLike = {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
};

export function formatZodError(error: ZodErrorLike): ValidationErrorBody {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.map((segment) => String(segment)).join('.');
    if (path) {
      (fieldErrors[path] ??= []).push(issue.message);
    } else {
      formErrors.push(issue.message);
    }
  }

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
        const hookResult = await hook(result, c);
        if (hookResult instanceof Response) return hookResult;
      }
      if (!result.success) {
        return c.json(formatZodError(result.error as ZodErrorLike), 400);
      }
    }
  );
