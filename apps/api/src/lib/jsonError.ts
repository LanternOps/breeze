import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '@breeze/shared';

// Additive error helper (Phase-3 Task 3). Emits the existing `{ error }` prose
// UNCHANGED and rides a machine-readable `code` alongside it, so the web can
// translate by code (apps/web/src/lib/runAction.ts) while every out-of-PR test
// and AI tool that asserts on the prose string keeps passing. Routes adopt this
// opportunistically in Task 4's waves; it changes no prose.
export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ error: message, code }, status);
}
