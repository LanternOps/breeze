// apps/web/src/components/organizations/board/boardTestKit.ts
/**
 * Fixtures and the fetch router shared by every OrganizationsBoardPage test.
 * Not a test file itself (no `.test.` suffix), so vitest never runs it; it
 * carries no `t()` calls and no hash reads, so the contract scans ignore it.
 * Each test file still declares its own `vi.mock(...)` block (vi.mock is
 * hoisted per file and cannot be shared).
 */
import { act } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { Organization } from '@/components/settings/organizationTypes';
import type { AccountReadinessResponse, ReadinessCapabilities, ReadinessOrg } from '@/lib/orgReadiness';

export const ALL_CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false, contracts: false, backup: false,
};

export const ALPHA: Organization = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', type: 'customer', deviceCount: 3, createdAt: '2026-01-01T00:00:00Z' };
export const BETA: Organization = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Beta Ltd', status: 'trial', type: 'customer', deviceCount: 5, createdAt: '2026-01-02T00:00:00Z' };
export const GAMMA: Organization = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma Internal', status: 'active', type: 'internal', deviceCount: 0, createdAt: '2026-01-03T00:00:00Z' };
export const ARCHIVED_ORG: Organization = { id: 'dddddddd-4444-4444-8444-444444444444', name: 'Delta Archived', status: 'archived', deviceCount: 0, createdAt: '2026-01-04T00:00:00Z', archived: true, purgeAt: '2026-10-13T00:00:00.000Z' };
/** #4166 — mid-archive drain: read-only through the archived door, still uninstalling agents. */
export const DRAINING_ORG: Organization = { id: 'eeeeeeee-5555-4555-8555-555555555555', name: 'Epsilon Draining', status: 'offboarding', offboardingTarget: 'archive', deviceCount: 2, createdAt: '2026-01-05T00:00:00Z', archived: true, purgeAt: null };
export const NEW_ORG_ID = 'ffffffff-6666-4666-8666-666666666666';

export type ReadinessOverrides = Partial<Omit<ReadinessOrg, 'setup' | 'account' | 'orgId'>> & {
  setup?: Partial<ReadinessOrg['setup']>;
  account?: Partial<ReadinessOrg['account']>;
};

/** A complete readiness row for `org` (every check satisfied); tests remove things from it. */
export function readinessFor(org: Organization, overrides: ReadinessOverrides = {}): ReadinessOrg {
  const { setup, account, ...rest } = overrides;
  return {
    orgId: org.id,
    type: org.type ?? 'customer',
    status: org.status,
    tickets: { open: 0, awaitingCustomer: 0, slaBreached: 0 },
    ...rest,
    setup: { sites: 1, devices: org.deviceCount ?? 0, lastSeenAt: '2026-09-13T11:00:00.000Z', policyAssigned: true, ...setup },
    account: {
      primaryContact: { name: 'Jane Doe', email: 'jane@alpha.test', phone: '+1 555 0100', mobile: null },
      billingRoleContact: true,
      billingAddress: true,
      pendingInvitations: 0,
      overdueInvoices: 0,
      ...account,
    },
  };
}

export const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

export interface BoardApiOptions {
  orgs?: Organization[];
  /** Readiness rows by org id; ids not listed get `readinessFor(org)` (complete). */
  readiness?: Record<string, ReadinessOrg>;
  capabilities?: ReadinessCapabilities;
  mode?: 'native' | 'external' | 'off';
  archivedOrgs?: Organization[];
  archivedTruncated?: boolean;
  /** Return a Response (or a promise of one) to override a readiness batch; undefined → default body. `call` is 1-based. */
  onReadiness?: (ids: string[], call: number) => Response | Promise<Response> | undefined;
  onOrder?: (call: number) => Response | Promise<Response>;
  onRestore?: () => { body: unknown; status?: number };
  onArchive?: () => unknown;
  onMergePoll?: () => unknown;
}

export interface BoardApi {
  /** What the list GET returns; mutate to model a server whose order or membership changed. */
  state: { orgs: Organization[] };
  readinessCalls: string[][];
}

/** Routes every fetch the page and its modals issue. The archived branch applies
 *  the API's server-side `search` so tests can prove the param narrows results. */
export function mockBoardApi(fetchMock: Mock, opts: BoardApiOptions = {}): BoardApi {
  const state = { orgs: [...(opts.orgs ?? [ALPHA, BETA, GAMMA])] };
  const readinessCalls: string[][] = [];
  let orderCalls = 0;
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.startsWith('/orgs/account-readiness?')) {
      const ids = new URL(url, 'http://localhost').searchParams.get('orgIds')!.split(',');
      readinessCalls.push(ids);
      const override = opts.onReadiness?.(ids, readinessCalls.length);
      if (override) return override;
      const known = [...state.orgs, ...(opts.archivedOrgs ?? [])];
      const body: AccountReadinessResponse = {
        partnerId: 'partner-1',
        capabilities: opts.capabilities ?? ALL_CAPS,
        serviceManagementMode: opts.mode ?? 'native',
        orgs: ids.flatMap((id) => {
          const org = known.find((o) => o.id === id);
          return org ? [opts.readiness?.[id] ?? readinessFor(org)] : [];
        }),
      };
      return jsonResponse(body);
    }
    if (url.includes('includeArchived=true')) {
      const search = new URL(url, 'http://localhost').searchParams.get('search')?.toLowerCase();
      const archived = (opts.archivedOrgs ?? []).filter((org) => (search ? org.name.toLowerCase().includes(search) : true));
      return jsonResponse({
        data: [...state.orgs, ...archived],
        pagination: { page: 1, limit: 100, total: state.orgs.length },
        archivedTruncated: opts.archivedTruncated ?? false,
      });
    }
    if (url.startsWith('/orgs/organizations?') && !method) {
      return jsonResponse({ data: state.orgs, pagination: { page: 1, limit: 100, total: state.orgs.length } });
    }
    if (url === '/orgs/organizations/order' && method === 'PATCH') {
      orderCalls += 1;
      return opts.onOrder ? opts.onOrder(orderCalls) : jsonResponse({ ok: true });
    }
    if (url === '/orgs/organizations' && method === 'POST') {
      const values = JSON.parse(String(init?.body)) as { name: string; status: Organization['status'] };
      state.orgs = [...state.orgs, { id: NEW_ORG_ID, name: values.name, status: values.status, type: 'customer', deviceCount: 0, createdAt: '2026-09-13T12:00:00Z' }];
      return jsonResponse({ id: NEW_ORG_ID, name: values.name });
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/restore$/.test(url)) {
      const result = opts.onRestore?.() ?? { body: { status: 'active', recreateRequired: [] } };
      const status = result.status ?? 200;
      return jsonResponse(result.body, status < 400, status);
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/archive$/.test(url)) {
      return jsonResponse(opts.onArchive?.() ?? { status: 'offboarding', purgeAt: '2026-11-24T00:00:00.000Z' }, true, 202);
    }
    if (method === 'POST' && url.endsWith('/merge-preview')) {
      return jsonResponse({ tables: [{ table: 'devices', policy: 'repoint-dedupe', loserRows: 4, wouldDrop: 0 }], totalMovableRows: 4, verdict: 'ok', warnings: [] });
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/merge$/.test(url)) return jsonResponse({ jobId: 'job-1' }, true, 202);
    if (url.includes('/merge-runs/')) {
      return jsonResponse(opts.onMergePoll?.() ?? { state: 'completed', result: { tables: { devices: { moved: 4, dropped: 0 } }, warnings: [], mergeEventId: 'evt-1' } });
    }
    return jsonResponse({ data: [] });
  });
  return { state, readinessCalls };
}

/** Advance fake timers inside act; default 0 settles a resolved mock fetch's microtask chain. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Rendered order of the DESKTOP table's rows, top to bottom (the phone cards also render in jsdom). */
export const renderedRowIds = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid="responsive-table-desktop"] [data-testid^="org-board-row-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('org-board-row-', ''),
  );
