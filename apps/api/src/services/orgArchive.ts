import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { envInt } from '../utils/envInt';
import { liftArchiveSuspension } from './tenantLifecycle';
import {
  abortOrganizationOffboarding,
  beginOrganizationOffboarding,
  finalizeOrganizationOffboarding,
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
} from './tenantOffboarding';

const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;
const MAX_ARCHIVE_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVABLE_STATUSES = ['active', 'trial', 'suspended'] as const;

/**
 * Pre-archive status, stashed in `organizations.settings` at entry and put back
 * by restore — the same mechanism `services/orgMerge.ts` uses for the fenced
 * loser (`MERGE_PRIOR_STATUS_KEY`), for the identical reason and over the
 * identical status set.
 *
 * Without it, restore hard-coded `status: 'active'`, so archive→restore was a
 * two-call SUSPENSION RESET: a customer suspended for non-payment or abuse came
 * back fully active, and (because the archive re-tagged its device suspensions)
 * with its whole fleet reconnected — with nothing left in the status column
 * recording that it had ever been suspended. The `trial` case was quieter but
 * the same defect: a trial org silently promoted to `active`.
 */
export const ARCHIVE_PRIOR_STATUS_KEY = 'archivePriorStatus';

/**
 * Statuses restore will hand back. A hand-edited, absent or since-retired value
 * falls back to `active` rather than raising an enum cast error inside a
 * recovery path — same defensive shape as `unfenceLoser`'s CASE. The fallback is
 * `active` (not `suspended`) because this key is only ever written by
 * `beginOrgArchive` from a status in ARCHIVABLE_STATUSES, so a miss means the
 * row predates the key, and those rows were archived from active by definition.
 */
const RESTORABLE_PRIOR_STATUSES = ['active', 'trial', 'suspended'] as const;

/** `organizations.type` values archive refuses outright. */
const NON_ARCHIVABLE_ORG_TYPES = ['quick_support'] as const;

/**
 * Schema evidence for archive reversibility:
 * - devices: agent_token_suspended_at + agent_token_suspended_reason (reversible)
 * - api_keys: status active/revoked/expired only (no suspension reason)
 * - oauth_grants/oauth_refresh_tokens: revoked_at only (irreversible)
 * - enrollment_keys: expires_at only (irreversible)
 * - user sessions: token revocation/epoch advancement only (irreversible)
 *
 * The one-way surfaces are deliberately left untouched and remain unusable
 * through the org status gate. These notes are returned verbatim so callers
 * can explain both the one actual recreation requirement and the preserved
 * surfaces without claiming that archive silently restored irreversible data.
 */
export const REVERSIBILITY_NOTES: string[] = [
  'Agents that completed the archive uninstall must be re-enrolled.',
];

export class OrgArchiveStateError extends Error {
  constructor(
    message: string,
    readonly currentStatus: string | null = null
  ) {
    super(message);
    this.name = 'OrgArchiveStateError';
  }
}

export interface BeginOrgArchiveInput {
  orgId: string;
  retentionDays: number | null | undefined;
  actor: string | null;
  /** Test clock; callers omit this. */
  now?: Date;
}

export interface RestoreOrgFromArchiveInput {
  orgId: string;
  actor: string | null;
}

export interface RestoreOrgFromArchiveResult {
  /** The status the org was put back to — its PRE-archive status, not always 'active'. */
  status: string;
  recreateRequired: string[];
  /** True when this restore aborted an in-flight archive drain rather than un-archiving. */
  aborted: boolean;
  uninstallsCancelled: number;
}

/**
 * `settings.<key>` restored as a validated org_status, defaulting when the key
 * is absent or not one we wrote. Shared by both restore CASes so the two paths
 * can never drift apart.
 */
function priorStatusExpression() {
  const allowed = sql.join(
    RESTORABLE_PRIOR_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`(
    CASE
      WHEN settings->>${ARCHIVE_PRIOR_STATUS_KEY} IN (${allowed})
        THEN settings->>${ARCHIVE_PRIOR_STATUS_KEY}
      ELSE 'active'
    END
  )::org_status`;
}

/**
 * The columns every exit from archive intent clears, as ONE atomic assignment
 * list. `offboarding_target` is NOT NULL DEFAULT 'churn', so clearing archive
 * intent means restoring the schema default, never writing an impossible NULL.
 * A restored-then-rearchived org must also receive a fresh warning cycle, and
 * the prior-status key is consumed by the restore that used it — so all three
 * settings keys are dropped in the same jsonb expression. Never read `settings`
 * into JS and write it back: that would clobber concurrent changes.
 */
function archiveExitAssignments() {
  return sql`
       status = ${priorStatusExpression()},
       archived_at = NULL,
       purge_at = NULL,
       offboarding_target = 'churn',
       settings = COALESCE(settings, '{}'::jsonb)
                  - ${ARCHIVE_PURGE_WARN_14_SENT_AT_KEY}
                  - ${ARCHIVE_PURGE_WARN_1_SENT_AT_KEY}
                  - ${ARCHIVE_PRIOR_STATUS_KEY}
                  - ${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY},
       updated_at = now()`;
}

/** Un-archive: `archived` → the stashed prior status. Exported for compiled-SQL assertion. */
export function buildArchiveRestoreCas(orgId: string): SQL {
  return sql`
    UPDATE organizations
       SET ${archiveExitAssignments()}
     WHERE id = ${orgId}::uuid
       AND status = 'archived'
     RETURNING id, status`;
}

/**
 * Abort an in-flight archive DRAIN: `offboarding` + `offboarding_target =
 * 'archive'` → the stashed prior status. The target check is what keeps this
 * from hijacking a CHURN drain, which is a different, deliberate one-way exit.
 */
export function buildArchiveDrainAbortCas(orgId: string): SQL {
  return sql`
    UPDATE organizations
       SET ${archiveExitAssignments()}
     WHERE id = ${orgId}::uuid
       AND status = 'offboarding'
       AND offboarding_target = 'archive'
     RETURNING id, status`;
}

function archiveRetentionDays(): number {
  const configured = envInt(
    'ORG_ARCHIVE_DEFAULT_RETENTION_DAYS',
    DEFAULT_ARCHIVE_RETENTION_DAYS
  );
  return configured >= 1 && configured <= MAX_ARCHIVE_RETENTION_DAYS
    ? configured
    : DEFAULT_ARCHIVE_RETENTION_DAYS;
}

export function computePurgeAt(
  retentionDays: number | null | undefined,
  now: Date = new Date()
): Date | null {
  if (retentionDays === null) return null;
  const days = retentionDays ?? archiveRetentionDays();
  if (!Number.isInteger(days) || days < 1 || days > MAX_ARCHIVE_RETENTION_DAYS) {
    throw new RangeError(`retentionDays must be an integer between 1 and ${MAX_ARCHIVE_RETENTION_DAYS}`);
  }
  return new Date(now.getTime() + days * DAY_MS);
}

export async function beginOrgArchive(
  input: BeginOrgArchiveInput
): Promise<{ status: 'offboarding' | 'archived'; purgeAt: Date | null }> {
  const now = input.now ?? new Date();
  const purgeAt = computePurgeAt(input.retentionDays, now);

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [organization] = await db
        .select({ status: organizations.status, type: organizations.type })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!organization) {
        throw new OrgArchiveStateError(`Organization ${input.orgId} was not found`);
      }
      // The hidden per-partner Quick Support org is a one-way door for archive:
      // `discoverArchivedOrgIds`/`loadArchivedOrg` both refuse it ("archiving is
      // not a way to surface it"), so once archived it is unreachable through
      // every read endpoint while the purge sweeper — which filters only on
      // status + purge_at — would still erase it and every support-session
      // record under it. `orgMerge` already refuses the same type outright.
      if (NON_ARCHIVABLE_ORG_TYPES.includes(organization.type as typeof NON_ARCHIVABLE_ORG_TYPES[number])) {
        throw new OrgArchiveStateError(
          `Organization ${input.orgId} is a '${organization.type}' organization and cannot be archived`,
          organization.status
        );
      }
      if (!ARCHIVABLE_STATUSES.includes(organization.status as typeof ARCHIVABLE_STATUSES[number])) {
        throw new OrgArchiveStateError(
          `Organization ${input.orgId} cannot be archived from status '${organization.status}'`,
          organization.status
        );
      }

      const entered = await db
        .update(organizations)
        .set({
          status: 'offboarding',
          offboardingStartedAt: null,
          offboardingTarget: 'archive',
          purgeAt,
          // Stash the pre-archive status so restore can put it back (see
          // ARCHIVE_PRIOR_STATUS_KEY). ONE atomic jsonb expression inside the
          // same status-guarded CAS, mirroring orgMerge's `fenceLoser` — never
          // a read-modify-write, which would clobber concurrent settings edits.
          // Every engine-owned key is DROPPED before the new prior-status is
          // stamped, so nothing can ride into this archive from a previous
          // cycle or from a client PATCH: a stale warning marker would suppress
          // this archive's purge warnings, and a preseeded recovery counter
          // would neuter the purge-retry ceiling before the org ever reaches
          // `purging`. (The API strips these keys from client payloads too —
          // services/orgSettingsInternalKeys.ts — and the counter's own SQL is
          // independently clamped; this is the lifecycle-boundary reset.)
          settings: sql`jsonb_set(
            COALESCE(${organizations.settings}, '{}'::jsonb)
              - ${ARCHIVE_PURGE_WARN_14_SENT_AT_KEY}
              - ${ARCHIVE_PURGE_WARN_1_SENT_AT_KEY}
              - ${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY},
            '{${sql.raw(ARCHIVE_PRIOR_STATUS_KEY)}}',
            to_jsonb(${organization.status}::text),
            true
          )`,
          updatedAt: now,
        })
        .where(
          and(
            eq(organizations.id, input.orgId),
            eq(organizations.status, organization.status)
          )
        )
        .returning({ id: organizations.id });

      if (entered.length === 0) {
        throw new OrgArchiveStateError(
          `Organization ${input.orgId} changed state before archive entry`,
          organization.status
        );
      }

      if (organization.status === 'suspended') {
        const finalized = await finalizeOrganizationOffboarding(input.orgId, {
          forcedByDeadline: false,
        });
        if (!finalized) {
          throw new OrgArchiveStateError(
            `Organization ${input.orgId} changed state before archive finalization`,
            'offboarding'
          );
        }
        return { status: 'archived', purgeAt };
      }

      await beginOrganizationOffboarding(input.orgId, input.actor, {
        target: 'archive',
        purgeAt,
      });
      return { status: 'offboarding', purgeAt };
    })
  );
}

/**
 * Bring an org back out of archive intent, from EITHER end of the transition:
 *
 *  1. `archived` — the ordinary un-archive.
 *  2. `offboarding` + `offboarding_target='archive'` — the ABORT edge the spec's
 *     state machine draws but Wave 4 never built. Without it, a mis-clicked
 *     archive was uncancellable for the whole drain window (up to 72h) while
 *     `self_uninstall` was delivered to the customer's entire fleet: restore
 *     409'd on the `status='archived'` CAS, PATCH 404'd (the org is outside
 *     `accessibleOrgIds`), and the org was invisible in every list. The one loss
 *     archive exists to avoid — hand re-enrolment — was the guaranteed outcome.
 *
 * A CHURN drain is deliberately NOT restorable here: the `offboarding_target`
 * check keeps this endpoint from hijacking the other, intentional one-way exit.
 *
 * Both paths restore the PRE-archive status and run in ONE system transaction,
 * with the uninstall cancellation ordered BEFORE the status flip: if the CAS
 * then loses a race and throws, the whole transaction rolls back, so the failure
 * mode is "still draining" — never "live and billable with uncollected
 * self_uninstalls queued to its fleet".
 */
export async function restoreOrgFromArchive(
  input: RestoreOrgFromArchiveInput
): Promise<RestoreOrgFromArchiveResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const restored = (await db.execute(
        buildArchiveRestoreCas(input.orgId)
      )) as unknown as Array<{ id: string; status: string }>;

      if (restored.length > 0) {
        await liftArchiveSuspension(input.orgId);
        return {
          status: restored[0]!.status,
          recreateRequired: [...REVERSIBILITY_NOTES],
          aborted: false,
          uninstallsCancelled: 0,
        };
      }

      const [current] = await db
        .select({
          status: organizations.status,
          offboardingTarget: organizations.offboardingTarget,
        })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!current) {
        throw new OrgArchiveStateError(`Organization ${input.orgId} was not found`);
      }
      if (current.status !== 'offboarding' || current.offboardingTarget !== 'archive') {
        throw new OrgArchiveStateError(
          `Organization ${input.orgId} is not archived and cannot be restored`,
          current.status
        );
      }

      // Cancel the queued self_uninstalls FIRST — an uncollected uninstall must
      // never survive into a reactivated tenant. Same transaction as the CAS
      // below (abortOrganizationOffboarding reuses the ambient system context).
      const { uninstallsCancelled } = await abortOrganizationOffboarding(input.orgId);

      const aborted = (await db.execute(
        buildArchiveDrainAbortCas(input.orgId)
      )) as unknown as Array<{ id: string; status: string }>;

      if (aborted.length === 0) {
        throw new OrgArchiveStateError(
          `Organization ${input.orgId} changed state before the archive drain could be aborted`,
          current.status
        );
      }

      // No-op unless the drain had already reached the suspension step; kept so
      // both exits leave identical device state.
      await liftArchiveSuspension(input.orgId);
      return {
        status: aborted[0]!.status,
        recreateRequired: [...REVERSIBILITY_NOTES],
        aborted: true,
        uninstallsCancelled,
      };
    })
  );
}
