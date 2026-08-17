import type { WorkspaceDatabase } from '../hostTypes';
import { and, desc, eq, or } from 'drizzle-orm';
import { workspaceCrawlRuns, workspaceSources } from '../schema/workspace';

export interface SourceInput {
  kind: 'smb_share' | 'local_profile';
  displayName: string;
  rootPath: string;
  crawlDeviceId?: string | null;
  visibilityGroupIds: string[];
  crawlCadenceMinutes: number;
  excludeGlobs: string[];
  watch: boolean;
  status: 'active' | 'paused';
}

type SourceRow = typeof workspaceSources.$inferSelect;
export type CrawlRunRow = typeof workspaceCrawlRuns.$inferSelect;

/**
 * What every consumer outside the credential service gets: the raw row minus
 * credentialEnc, plus a computed hasCredential. Ciphertext never leaves this
 * module — a route cannot leak what it never receives. The credential service
 * reads credential_enc through its own scoped query.
 */
export type SafeSourceRow = Omit<SourceRow, 'credentialEnc'> & { hasCredential: boolean };

function toSafeRow(row: SourceRow): SafeSourceRow {
  const { credentialEnc, ...rest } = row;
  return { ...rest, hasCredential: Boolean(credentialEnc) };
}

/** User-input problem (400-class), as opposed to an internal failure. */
export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceValidationError';
  }
}

/**
 * Validates a COMPLETE source state (post-merge on update, the input itself on
 * create). #3472: this is the service-level boundary, so a caller that bypasses
 * the Hono schema still cannot persist a forbidden shape.
 */
function validateSourceState(input: SourceInput): void {
  if (input.kind === 'local_profile') {
    // crawl_device_id is only meaningful for smb_share. A local_profile row
    // carrying one is what deviceSummaryService's owned-sources branch absorbs
    // with `device_id IS NULL`; without it the source would attribute every
    // OTHER device's device-scoped rows to its crawl device.
    if (input.crawlDeviceId) {
      throw new SourceValidationError('local_profile sources cannot have a crawl device');
    }
    return;
  }
  if (input.kind !== 'smb_share') return;
  if (!input.crawlDeviceId) {
    throw new SourceValidationError('smb_share requires crawlDeviceId');
  }
  if (!/^\\\\/.test(input.rootPath)) {
    throw new SourceValidationError('smb_share rootPath must be a UNC path');
  }
}

export function createSourcesService(d: WorkspaceDatabase) {
  return {
    async list(orgId: string): Promise<SafeSourceRow[]> {
      const rows = await d.select().from(workspaceSources)
        .where(eq(workspaceSources.orgId, orgId))
        .orderBy(workspaceSources.displayName);
      return rows.map(toSafeRow);
    },

    async get(orgId: string, id: string): Promise<SafeSourceRow | null> {
      const [row] = await d.select().from(workspaceSources)
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, id)))
        .limit(1);
      return row ? toSafeRow(row) : null;
    },

    async create(orgId: string, input: SourceInput): Promise<SafeSourceRow> {
      validateSourceState(input);
      const [row] = await d.insert(workspaceSources).values({ orgId, ...input }).returning();
      if (!row) throw new Error('Failed to create workspace source');
      return toSafeRow(row);
    },

    async update(
      orgId: string,
      id: string,
      patch: Partial<SourceInput>,
    ): Promise<SafeSourceRow | null> {
      // #3472: validate the MERGED state here, not just at the route. A caller
      // reaching the service directly (or a future second route) would
      // otherwise write a local_profile carrying a crawl device, which is
      // exactly the shape this invariant exists to prevent.
      //
      // A flip to local_profile is REJECTED rather than silently clearing the
      // crawl device: that assignment is operator configuration, and a body
      // that says only `{kind:'local_profile'}` has not authorised deleting it.
      // The web form already submits `crawlDeviceId: null` explicitly
      // (web/sourcesPage.ts), so intentional flips are unaffected.
      const [current] = await d.select().from(workspaceSources)
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, id)))
        .limit(1);
      if (!current) return null;
      validateSourceState({
        kind: patch.kind ?? current.kind,
        displayName: patch.displayName ?? current.displayName,
        rootPath: patch.rootPath ?? current.rootPath,
        crawlDeviceId: patch.crawlDeviceId === undefined
          ? current.crawlDeviceId
          : patch.crawlDeviceId,
        visibilityGroupIds: patch.visibilityGroupIds ?? current.visibilityGroupIds,
        crawlCadenceMinutes: patch.crawlCadenceMinutes ?? current.crawlCadenceMinutes,
        excludeGlobs: patch.excludeGlobs ?? current.excludeGlobs,
        watch: patch.watch ?? current.watch,
        status: patch.status ?? current.status,
      } as SourceInput);

      const [row] = await d.update(workspaceSources)
        .set({
          ...patch,
          // Flipping a source away from smb_share would strand unreachable
          // ciphertext (credentials are only served for SMB sources) — clear it.
          ...(patch.kind === 'local_profile' ? { credentialEnc: null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, id)))
        .returning();
      return row ? toSafeRow(row) : null;
    },

    async remove(orgId: string, id: string): Promise<boolean> {
      const rows = await d.delete(workspaceSources)
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, id)))
        .returning({ id: workspaceSources.id });
      return rows.length > 0;
    },

    /**
     * Agent-visible sources for a device. Visibility rules: only status
     * 'active' sources are handed to agents (paused and errored sources are
     * withheld); every local_profile source is visible to every device in the
     * org; smb_share sources are visible only to their assigned crawl device.
     */
    async listForDevice(orgId: string, deviceId: string): Promise<SafeSourceRow[]> {
      const rows = await d.select().from(workspaceSources)
        .where(and(
          eq(workspaceSources.orgId, orgId),
          eq(workspaceSources.status, 'active'),
          or(
            eq(workspaceSources.kind, 'local_profile'),
            eq(workspaceSources.crawlDeviceId, deviceId),
          ),
        ))
        .orderBy(workspaceSources.displayName);
      return rows.map(toSafeRow);
    },

    async listRuns(orgId: string, sourceId: string, limit = 50): Promise<CrawlRunRow[]> {
      return d.select().from(workspaceCrawlRuns)
        .where(and(
          eq(workspaceCrawlRuns.orgId, orgId),
          eq(workspaceCrawlRuns.sourceId, sourceId),
        ))
        .orderBy(desc(workspaceCrawlRuns.startedAt))
        .limit(limit);
    },
  };
}
