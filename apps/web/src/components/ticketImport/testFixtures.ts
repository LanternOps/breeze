/**
 * Shared fixtures for the ticket import wizard's component tests (#8313 W6).
 * Test-only: no app module imports this file.
 */
import type { ImportRun, ImportSourceDetail, MigrationWindow, Preflight, RunCounters } from './ticketImportApi';

export const SOURCE_ID = '6f1c2b0a-5d4e-4f3a-8b2c-1d0e9f8a7b6c';
export const PRINCIPAL_ID = '0a7d9c1e-2b3f-4a5d-8e6f-7a8b9c0d1e2f';
export const PARTNER_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const WINDOW_ID = '33333333-3333-4333-8333-333333333333';
export const ME = 'user-me';

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export function sourceDetail(over: Partial<ImportSourceDetail> = {}): ImportSourceDetail {
  return {
    id: SOURCE_ID,
    partnerId: PARTNER_ID,
    module: 'zammad',
    label: 'Zammad',
    baseUrl: 'https://helpdesk.example.com',
    principalId: PRINCIPAL_ID,
    ownerUserId: ME,
    options: {},
    hasCredentials: true,
    revokedAt: null,
    revokedBy: null,
    createdBy: ME,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    activeRunId: null,
    mappings: { orgs: [], categories: [] },
    ...over,
  };
}

export function preflight(over: Partial<Preflight> = {}): Preflight {
  return {
    connect: {
      identity: { key: '7', name: 'Breeze Import', email: 'import@example.com' },
      permissions: ['ticket.agent'],
      warnings: [{ code: 'group_inactive', detail: 'Archive' }, { code: 'token_not_read_only' }],
      clockSkewMs: 1200,
      sourceVersion: '7.2.2',
    },
    catalog: {
      orgs: [{ key: '1', name: 'Acme', active: true }, { key: '2', name: 'Globex', active: true }],
      groups: [{ key: '10', name: 'Support', active: true, readable: true }, { key: '11', name: 'Archive', active: false, readable: false }],
      priorities: [{ key: '1', name: '1 low' }, { key: '2', name: '2 normal' }, { key: '3', name: '3 high' }, { key: '4', name: 'VIP' }],
      states: [{ key: '1', name: 'new (new)' }, { key: '9', name: 'waiting (open)' }],
      attributes: [{ key: 'contract', name: 'Contract' }],
      counts: { users: 42, invalidRows: 0 },
    },
    objectStorage: { configured: true },
    ...over,
  };
}

export function counters(over: Partial<RunCounters> = {}): RunCounters {
  return {
    tickets: { seen: 10, created: 6, resumed: 1, unchanged: 2, skipped: 1, failed: 0 },
    comments: { written: 30, skipped: 0, systemSkipped: 4 },
    attachments: { written: 3, skipped: 1, bytes: 2048, alternativesIgnored: 0 },
    linksWritten: 0,
    linksAsNotes: 0,
    statusKept: 0,
    contentTruncated: 0,
    clockClamped: 0,
    deletedInSource: 0,
    hiddenInSource: 0,
    removedInBreeze: 0,
    mergedInBreeze: 0,
    ownersUnmatched: 1,
    requestersWithoutContact: 2,
    contactsCreated: 0,
    commentsChangedInSource: 0,
    commentsMissingInSource: 0,
    requestersChangedInSource: 0,
    orgsChangedInSource: 0,
    customAttributes: {},
    moduleCounts: {},
    issuesWritten: 0,
    issuesDropped: 0,
    predicted: {
      creates: 7, resumes: 0, comments: 30, attachments: 4, attachmentBytes: 4096, attachmentsSkipped: 1, invalid: 0,
      contactsToCreate: {}, contactsToCreateOverCap: 0,
    },
    ...over,
  };
}

export function importRun(over: Partial<ImportRun> = {}): ImportRun {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    sourceId: SOURCE_ID,
    kind: 'dry_run',
    windowId: null,
    state: 'completed',
    stopReason: null,
    phase: 'done',
    counters: counters(),
    startedBy: ME,
    startedAt: '2026-11-12T09:00:00.000Z',
    heartbeatAt: null,
    finishedAt: '2026-11-12T09:10:00.000Z',
    ...over,
  };
}

export function migrationWindow(over: Partial<MigrationWindow> = {}): MigrationWindow {
  return {
    id: WINDOW_ID,
    partnerId: PARTNER_ID,
    principalId: PRINCIPAL_ID,
    sourceLabel: 'Zammad',
    status: 'open',
    openedAt: '2026-11-12T08:00:00.000Z',
    endsAt: '2026-11-15T08:00:00.000Z',
    writesPerHour: 6000,
    openedBy: ME,
    closedBy: null,
    closedReason: null,
    closedAt: null,
    orgIds: [ORG_A],
    counts: {
      orgs: [{ orgId: ORG_A, ticketsImported: 5, commentsImported: 9, attachmentsImported: 1 }],
      ticketsImported: 5,
      commentsImported: 9,
      attachmentsImported: 1,
    },
    ...over,
  };
}
