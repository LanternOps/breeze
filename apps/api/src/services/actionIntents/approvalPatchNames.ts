/**
 * The patches a `manage_patches` install names, for its approval headline.
 *
 * The guardrail headline counts them (`Install 3 patches on 2 devices`), so
 * an approver confirmed a passkey prompt without seeing which patch was going
 * to be installed. This module turns the install's `patchIds` into names an
 * approver recognises; `buildActionLabel` (actionLabel.ts) puts them in place
 * of the count. It mirrors approvalDeviceName.ts, and four properties are
 * load-bearing:
 *
 *  - **Org-pinned through `device_patches`.** `patches` is GLOBAL: deduped on
 *    `(source, external_id)` with no tenant column (routes/agents/patches.ts).
 *    A patch is never read by id alone. It is read only through a
 *    `device_patches` row of the intent's org, on a device the call names, for
 *    a patch the call names. A foreign or unknown id resolves to nothing and
 *    the count stays.
 *  - **Follows the filing caller's reach (#11674).** The caller's org
 *    condition is applied to `device_patches.org_id`, and only devices inside
 *    its site allowlist and exact-device ceiling are read. A principal with no
 *    org condition gets the count, with no read.
 *  - **Titles are untrusted.** `patches.title` is first-writer-wins from ANY
 *    tenant's agent, and the headline is passkey-approved. A bare KB number
 *    is shown only for a Microsoft-source row, taken from its `external_id`
 *    (its identity: rows are deduped on `(source, external_id)`), never from
 *    a title or a third-party id, where any tenant could plant a
 *    trusted-looking KB. Every other row shows its title cut to an allowlist
 *    (letters, digits, spaces and a little ASCII punctuation), collapsed,
 *    capped and quoted, so it reads as data and can neither forge a device
 *    stub nor close its own quotes.
 *  - **Never fatal.** A headline is presentation. A failed read degrades to
 *    the count, reported to Sentry, never swallowed.
 */

import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devicePatches, patches } from '../../db/schema/patches';
import { captureException } from '../sentry';
import { deviceInCallerReach, hasCallerOrgReach, type ApprovalCallerReach } from './approvalDeviceName';

/** Each id list is cut to this many. The headline shows two names; the rest only need to be countable. */
export const MAX_APPROVAL_PATCH_IDS = 50;

/** Longest title shown, in characters, before the quotes. */
const MAX_TITLE_LENGTH = 60;

/** Shape-only UUID guard: `device_patches` ids are Postgres `uuid`s, so junk would raise 22P02. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KB_NUMBER = /\bKB\d{6,8}\b/i;

/**
 * What a title may keep, after NFKC: letters (any script), digits, plain
 * spaces and a short list of ASCII punctuation. An allowlist, not a denylist:
 * every quote look-alike, bidi override, control or format character, known
 * or not, is replaced by a space, so a title can neither appear to close the
 * quotes it is shown in nor reorder the text around it.
 */
const TITLE_DISALLOWED = /[^\p{L}\p{N} .,\-+()[\]/:_&#%']/gu;

/**
 * Modifier letters are `\p{L}` but include quote look-alikes (ʺ U+02BA,
 * ˮ U+02EE), so they are dropped too, except the two CJK ones common in
 * product names and shaped nothing like a quote: 々 (U+3005) and ー (U+30FC).
 */
const MODIFIER_LETTERS = /(?![\u3005\u30FC])\p{Lm}/gu;

/** Distinct, lower-cased UUIDs from a tool argument, in order, at most `MAX_APPROVAL_PATCH_IDS`. */
function boundedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !UUID_SHAPE.test(raw)) continue;
    const id = raw.toLowerCase();
    if (ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_APPROVAL_PATCH_IDS) break;
  }
  return ids;
}

/** The only source whose `external_id` is a Windows Update KB identity. */
const KB_SOURCE = 'microsoft';

/**
 * The name an approver sees for one patch row: a Microsoft-source row's KB
 * number from its `external_id`, otherwise its sanitized title in quotes.
 * Null when there is nothing to show.
 */
export function approvalPatchDisplayName(row: { source: string; title: string | null; externalId: string | null }): string | null {
  const kb = row.source === KB_SOURCE ? row.externalId?.match(KB_NUMBER)?.[0] : undefined;
  if (kb) return kb.toUpperCase();
  const clean = (row.title ?? '')
    .normalize('NFKC')
    // Combining marks go first, so none is left attached to a space.
    .replace(/\p{M}/gu, '')
    .replace(TITLE_DISALLOWED, ' ')
    .replace(MODIFIER_LETTERS, ' ')
    // `...` is how a device stub ends; a title must not look like one.
    .replace(/\.{3,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  const capped = chars.length > MAX_TITLE_LENGTH
    ? `${chars.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd()}…`
    : clean;
  return `"${capped}"`;
}

/**
 * Resolve an install's patches to display names, in argument order and once
 * each, or `null` when none resolves. Only patches present on a named device
 * of `orgId` inside the caller's reach are named.
 *
 * Opens its OWN system-scoped context outside any ambient one, as
 * `resolveApprovalDeviceName` does and for the same reason:
 * `createActionIntent` is reached from contextless stacks, where an ambient
 * read would silently see zero rows. System scope is safe only because of the
 * `device_patches` org pin and the caller's reach below.
 */
export async function resolveApprovalPatchNames(
  patchIdsArg: unknown,
  deviceIdsArg: unknown,
  orgId: string,
  reach: ApprovalCallerReach,
): Promise<string[] | null> {
  if (!hasCallerOrgReach(reach)) return null;
  const patchIds = boundedIds(patchIdsArg);
  const deviceIds = boundedIds(deviceIdsArg);
  if (patchIds.length === 0 || deviceIds.length === 0) return null;
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        // Inside the system context: the site check reads `devices` itself.
        const reachable: string[] = [];
        for (const deviceId of deviceIds) {
          if (await deviceInCallerReach(reach, deviceId)) reachable.push(deviceId);
        }
        if (reachable.length === 0) return null;

        const conditions: SQL[] = [
          eq(devicePatches.orgId, orgId),
          inArray(devicePatches.deviceId, reachable),
          inArray(devicePatches.patchId, patchIds),
        ];
        const reachCondition = reach.orgCondition(devicePatches.orgId);
        if (reachCondition) conditions.push(reachCondition);
        const rows = await db
          .selectDistinct({ id: patches.id, source: patches.source, title: patches.title, externalId: patches.externalId })
          .from(devicePatches)
          .innerJoin(patches, eq(patches.id, devicePatches.patchId))
          .where(and(...conditions))
          .limit(patchIds.length);

        const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
        const names: string[] = [];
        for (const id of patchIds) {
          const row = byId.get(id);
          const name = row ? approvalPatchDisplayName(row) : null;
          if (name) names.push(name);
        }
        return names.length > 0 ? names : null;
      }, 'actionIntents.approvalPatchNames'),
    );
  } catch (err) {
    // Reported, not swallowed: the only symptom is an approval headline that
    // quietly goes back to counting patches.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error('[actionIntents] Failed to resolve the approval patch names:', err);
    return null;
  }
}
