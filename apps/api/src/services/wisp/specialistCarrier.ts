/**
 * Wisp W07 — the release-side read of a `wisp_specialist_request` carrier
 * intent. A light module (db + schema only) so the tool handler can load it
 * without the intent-service graph, which imports the tool registry.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, type ActionIntent } from '../../db/schema/actionIntents';
import { WISP_SPECIALIST_REQUEST_TOOL } from './specialistPolicy';

/** Statuses in which the release path may run the carrier. */
const RELEASABLE_STATUSES: ReadonlySet<string> = new Set(['approved', 'executing']);

/**
 * The carrier intent a release is executing, IF it is one this request may
 * run under: the carrier tool, the same request id and org, decided by a
 * human, and claimed (or just approved) for release. System-scoped read: the
 * release worker holds no request context.
 */
export async function loadReleasableCarrierIntent(
  intentId: string,
  expect: { requestId: string; orgId: string },
): Promise<(ActionIntent & { decidedByUserId: string }) | null> {
  const [intent] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select()
    .from(actionIntents)
    .where(eq(actionIntents.id, intentId))
    .limit(1)));
  const stored = intent?.arguments as { requestId?: unknown } | undefined;
  if (
    !intent
    || intent.actionName !== WISP_SPECIALIST_REQUEST_TOOL
    || stored?.requestId !== expect.requestId
    || intent.orgId !== expect.orgId
    || !RELEASABLE_STATUSES.has(intent.status)
    || !intent.decidedByUserId
  ) {
    return null;
  }
  return intent as ActionIntent & { decidedByUserId: string };
}

