import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Some shared gates (requireMfa() in particular) deny by directly RETURNING a
 * Response rather than throwing. That convention only self-propagates when
 * Hono itself is the one invoking the middleware — its own dispatch loop
 * assigns each registered middleware's return value to `c.res`. Nested
 * inside a hand-rolled, manually-composed auth chain (see devPush.ts's
 * `devPushAuth` and customFieldValues.ts's `dualAuth`), a returned Response
 * is just a discarded local value one closure deeper: nothing forwards it
 * back up to the outermost call Hono actually dispatches, so the request
 * falls through as if the gate had succeeded — an empty/broken response
 * instead of the intended denial, though never with the wrapped handler
 * actually running (the real Hono `next` was never called either).
 *
 * This wraps such a call so a denial surfaces as a thrown HTTPException
 * instead, which propagates through every intervening `await` regardless of
 * nesting depth — exactly like the sibling gates in these same chains
 * (requireApiKeyScope, requireScope, requirePermission) already behave, since
 * those throw directly rather than returning.
 */
export async function propagateDenial(
  middleware: (c: Context, next: Next) => Promise<Response | void>,
  c: Context,
  next: Next,
): Promise<void> {
  const result = await middleware(c, next);
  if (result) {
    throw new HTTPException(result.status as ContentfulStatusCode, { res: result });
  }
}
