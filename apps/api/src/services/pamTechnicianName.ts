/**
 * #10190 W07 (OD-7 (b)): the technician name an end user may see on an
 * elevation outcome ("Approved by {technician} at {partner}").
 *
 * The name follows the device's remote-access `technician_identity_level`,
 * the same setting that decides what a remote-session prompt shows:
 *   - `generic`            → null (no name);
 *   - `name` / `name_email` → the decider's display name.
 * The email is never returned, at any level: an elevation outcome has no
 * place for it (`buildTechnicianDisplay` is called with no email).
 *
 * Best effort by design. It feeds `decidedBy.technicianName` on the
 * `pam_apply_v2` and `pam_request_notify` payloads, and nothing about it may
 * block or roll back the apply, the deny or the expiry: every failure is
 * `null`. Reads run in the caller's DB context, and inside a DB context the
 * whole lookup runs in its own savepoint: callers invoke it inside their
 * transaction (the apply worker under its actuation row lock, a deny inside
 * the decision), and a failed statement outside a savepoint would abort that
 * transaction, so the apply or deny it only decorates would fail too. A
 * decider row the context cannot see is `null`, never an error.
 */
import { eq } from 'drizzle-orm';

import { db, hasDbAccessContext, withDbTransaction } from '../db';
import { users } from '../db/schema';
import { buildTechnicianDisplay, resolveRemoteSessionPromptConfig } from '../routes/remote/helpers';

/** The prompt identity cap (code points), the same as the partner name's. */
export const PAM_TECHNICIAN_NAME_MAX = 120;

export type PamDecider = {
  /** The deciding user's display name, when the caller already has it. */
  name?: string | null;
  /** Otherwise the deciding user's id, read in the caller's context. */
  userId?: string | null;
};

export async function resolvePamTechnicianName(deviceId: string, decider: PamDecider): Promise<string | null> {
  if (!decider.name?.trim() && !decider.userId) return null; // nobody decided (expiry, auto approval)
  try {
    // A failure rolls back to this savepoint only, never the caller's work.
    return hasDbAccessContext()
      ? await withDbTransaction(() => lookupTechnicianName(deviceId, decider))
      : await lookupTechnicianName(deviceId, decider);
  } catch (err) {
    // resolveRemoteSessionPromptConfig already reports its own failures to
    // Sentry; this only records that the outcome went out without a name.
    console.warn(
      `[pamTechnicianName] technician name unavailable for device ${deviceId}; the outcome is sent without it:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function lookupTechnicianName(deviceId: string, decider: PamDecider): Promise<string | null> {
  const { identityLevel } = await resolveRemoteSessionPromptConfig(deviceId);
  if (identityLevel === 'generic') return null;

  let name = decider.name ?? null;
  if (!name?.trim() && decider.userId) {
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, decider.userId))
      .limit(1);
    name = row?.name ?? null;
  }
  const shown = buildTechnicianDisplay(identityLevel, name, null, null).name?.trim();
  if (!shown) return null;
  const points = Array.from(shown);
  return points.length <= PAM_TECHNICIAN_NAME_MAX ? shown : points.slice(0, PAM_TECHNICIAN_NAME_MAX).join('');
}
