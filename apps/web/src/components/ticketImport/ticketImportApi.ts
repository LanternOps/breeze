import { fetchWithAuth } from '../../stores/auth';

/**
 * The shapes the ticket import wizard reads (#8313 W6), mirrored from the API:
 * routes/ticketImports/*.ts, services/ticketImport/{sourceStore,runStore,
 * runReport,createdContacts,moduleContract}.ts, routes/migrationWindows.ts and
 * routes/partnerServicePrincipals.ts. Reads only: every mutation is sent from
 * the component that owns it, wrapped in runAction.
 *
 * Every call is partner-wide, so the header's selected org is never injected
 * (`skipOrgIdInjection`): these routes are not org-scoped.
 */
export const PARTNER_WIDE = { skipOrgIdInjection: true } as const;

export type ImportModule = { id: string; label: string; optionsSchema: unknown };

export type ImportSource = {
  id: string;
  partnerId: string;
  module: string;
  label: string;
  baseUrl: string;
  principalId: string;
  /** The principal's owner: the only user who may edit the source and its maps, and open its windows. */
  ownerUserId: string | null;
  options: Record<string, unknown>;
  hasCredentials: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  activeRunId: string | null;
};

export type ImportMappings = {
  orgs: Array<{ sourceOrgKey: string | null; sourceOrgName: string | null; orgId: string }>;
  categories: Array<{ sourceGroupKey: string; sourceGroupName: string | null; categoryId: string }>;
};

export type ImportSourceDetail = ImportSource & { mappings: ImportMappings };

export type ConnectReport = {
  identity: { key: string | null; name: string | null; email: string | null };
  permissions: string[];
  warnings: Array<{ code: string; detail?: string }>;
  clockSkewMs: number | null;
  sourceVersion?: string | null;
};

export type CatalogEntry = { key: string; name: string; active?: boolean; readable?: boolean };

export type SourceCatalog = {
  orgs: CatalogEntry[];
  groups: CatalogEntry[];
  priorities: CatalogEntry[];
  states: CatalogEntry[];
  attributes: CatalogEntry[];
  counts: Record<string, number>;
};

export type Preflight = { connect: ConnectReport; catalog: SourceCatalog; objectStorage: { configured: boolean } };

export type RunKind = 'dry_run' | 'import';
export type RunState = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled';
export const ACTIVE_RUN_STATES: readonly RunState[] = ['queued', 'running'];
export const isRunActive = (state: RunState): boolean => ACTIVE_RUN_STATES.includes(state);

export type RunCounters = {
  tickets: { seen: number; created: number; resumed: number; unchanged: number; skipped: number; failed: number };
  comments: { written: number; skipped: number; systemSkipped: number };
  attachments: { written: number; skipped: number; bytes: number; alternativesIgnored: number };
  linksWritten: number;
  linksAsNotes: number;
  statusKept: number;
  contentTruncated: number;
  clockClamped: number;
  deletedInSource: number;
  hiddenInSource: number;
  removedInBreeze: number;
  mergedInBreeze: number;
  ownersUnmatched: number;
  requestersWithoutContact: number;
  contactsCreated: number;
  commentsChangedInSource: number;
  commentsMissingInSource: number;
  requestersChangedInSource: number;
  orgsChangedInSource: number;
  customAttributes: Record<string, number>;
  moduleCounts: Record<string, number>;
  issuesWritten: number;
  issuesDropped: number;
  predicted: {
    creates: number;
    resumes: number;
    comments: number;
    attachments: number;
    attachmentBytes: number;
    attachmentsSkipped: number;
    invalid: number;
    contactsToCreate: Record<string, number>;
    contactsToCreateOverCap: number;
  };
};

export type ImportRun = {
  id: string;
  sourceId: string;
  kind: RunKind;
  windowId: string | null;
  state: RunState;
  stopReason: string | null;
  phase: 'scan' | 'links' | 'deletions' | 'done';
  counters: RunCounters;
  startedBy: string | null;
  startedAt: string;
  heartbeatAt: string | null;
  finishedAt: string | null;
};

/** services/ticketImport/runReport.ts RUN_ISSUE_KINDS, in the report's reading order. */
export const RUN_ISSUE_KINDS = [
  'comments_changed',
  'requester_changed',
  'status_kept',
  'deleted_in_source',
  'hidden_in_source',
  'comments_missing',
  'org_changed',
  'failed',
  'row_unreadable',
  'skipped_no_org',
  'skipped_unsupported',
  'owner_unmatched',
  'attachments_skipped',
  'link_not_written',
  'probe_deferred',
  'removed_in_breeze',
  'merged_in_breeze',
  'content_truncated',
] as const;
export type RunIssueKind = (typeof RUN_ISSUE_KINDS)[number];

export type RunIssue = {
  id: string;
  sourceTicketKey: string | null;
  sourceTicketNumber: string | null;
  kind: string;
  code: string | null;
  count: number;
  createdAt: string;
};

export type KeptReason = 'portal_login' | 'role' | 'other_link' | 'edited' | 'in_use';
export const KEPT_REASONS: readonly KeptReason[] = ['portal_login', 'role', 'other_link', 'edited', 'in_use'];

export type CreatedContact = {
  contactId: string;
  orgId: string;
  name: string | null;
  email: string | null;
  sourceUserKey: string;
  createdAt: string;
  keptBecause: KeptReason[];
};

export type RemoveCreatedContactsResult = {
  removed: number;
  skipped: number;
  skippedBy: Record<KeptReason, number>;
  remaining: number;
  stoppedBy: 'run_active' | null;
};

export type WindowCounts = {
  orgs: Array<{ orgId: string; ticketsImported: number; commentsImported: number; attachmentsImported: number }>;
  ticketsImported: number;
  commentsImported: number;
  attachmentsImported: number;
};

export type MigrationWindow = {
  id: string;
  partnerId: string;
  principalId: string;
  sourceLabel: string;
  status: 'open' | 'closed';
  openedAt: string;
  endsAt: string;
  writesPerHour: number;
  openedBy: string | null;
  closedBy: string | null;
  closedReason: 'expired' | 'closed_by_admin' | 'principal_inactive' | 'opener_inactive' | null;
  closedAt: string | null;
  orgIds: string[];
  /** Live while open; the frozen summary once closed. */
  counts: WindowCounts;
};

export type ServicePrincipal = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  scopes: string[];
  expiresAt: string | null;
  owner: { id: string; name: string | null };
  keys: Array<{ id: string; status: string; expiresAt: string | null }>;
};

/** Each module's credential field names (the API seals whatever named strings it is sent). */
export const MODULE_CREDENTIAL_FIELD: Record<string, string> = { zammad: 'token' };

export class ImportReadError extends Error {
  constructor(readonly status: number) {
    super(`ticket import read failed (${status})`);
    this.name = 'ImportReadError';
  }
}

/** A GET that answers `{ data }` (and `next` when paged); throws ImportReadError otherwise. */
export async function readImport<T>(path: string): Promise<{ data: T; next: string | null }> {
  const response = await fetchWithAuth(path, { ...PARTNER_WIDE, method: 'GET' });
  if (!response.ok) throw new ImportReadError(response.status);
  const body = (await response.json().catch(() => null)) as { data?: T; next?: string | null } | null;
  if (!body || body.data === undefined) throw new ImportReadError(response.status);
  return { data: body.data, next: body.next ?? null };
}

/**
 * The principals a new source may be bound to (spec §5.6, §5.7): the caller
 * owns it, it is active and unexpired, holds tickets:write, has no active key
 * and no source yet. The API checks all of it again under a lock.
 */
export function reusablePrincipals(
  principals: readonly ServicePrincipal[],
  sources: readonly ImportSource[],
  userId: string | null,
  now: number = Date.now(),
): ServicePrincipal[] {
  const bound = new Set(sources.map((s) => s.principalId));
  const live = (expiresAt: string | null) => expiresAt === null || new Date(expiresAt).getTime() > now;
  return principals.filter((p) => userId !== null
    && p.owner.id === userId
    && p.status === 'active'
    && live(p.expiresAt)
    && p.scopes.includes('tickets:write')
    && !p.keys.some((k) => k.status === 'active' && live(k.expiresAt))
    && !bound.has(p.id));
}

/** The source's window: its principal's open one, else the newest it had. */
export function windowsOfSource(windows: readonly MigrationWindow[], source: ImportSource | null): {
  open: MigrationWindow | null;
  latest: MigrationWindow | null;
} {
  if (!source) return { open: null, latest: null };
  const own = windows
    .filter((w) => w.principalId === source.principalId)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return { open: own.find((w) => w.status === 'open') ?? null, latest: own[0] ?? null };
}

/** The Breeze orgs a source's mappings write to: every mapped org and the fallback, once each. */
export function mappedOrgIds(mappings: ImportMappings | null | undefined): string[] {
  if (!mappings) return [];
  return [...new Set(mappings.orgs.map((m) => m.orgId))].sort();
}
