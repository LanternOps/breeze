import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { envInt } from '../utils/envInt';
import { liftArchiveSuspension } from './tenantLifecycle';
import {
  beginOrganizationOffboarding,
  finalizeOrganizationOffboarding,
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
} from './tenantOffboarding';

const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;
const MAX_ARCHIVE_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVABLE_STATUSES = ['active', 'trial', 'suspended'] as const;

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
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!organization) {
        throw new OrgArchiveStateError(`Organization ${input.orgId} was not found`);
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

export async function restoreOrgFromArchive(
  input: RestoreOrgFromArchiveInput
): Promise<{ recreateRequired: string[] }> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const restored = await db
        .update(organizations)
        .set({
          status: 'active',
          archivedAt: null,
          purgeAt: null,
          // NOT NULL DEFAULT 'churn': clearing archive intent means restoring
          // the schema default, not writing an impossible NULL.
          offboardingTarget: 'churn',
          // A restored-then-rearchived org must receive a fresh warning cycle.
          // Keep this as one atomic jsonb expression inside the archived-only
          // CAS; never read settings into JS and overwrite concurrent changes.
          settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) - ${ARCHIVE_PURGE_WARN_14_SENT_AT_KEY} - ${ARCHIVE_PURGE_WARN_1_SENT_AT_KEY}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(organizations.id, input.orgId),
            eq(organizations.status, 'archived')
          )
        )
        .returning({ id: organizations.id });

      if (restored.length === 0) {
        throw new OrgArchiveStateError(
          `Organization ${input.orgId} is not archived and cannot be restored`
        );
      }

      await liftArchiveSuspension(input.orgId);
      return { recreateRequired: [...REVERSIBILITY_NOTES] };
    })
  );
}
