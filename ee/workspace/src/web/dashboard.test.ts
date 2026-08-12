import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildViewModel,
  WorkspaceDashboard,
  type DashboardJob,
  type DashboardSummary,
} from './dashboard';
import { defineWorkspaceElements } from './index';

function emptySummary(): DashboardSummary {
  return {
    sources: [],
    ingest: {
      eligible: 0, extracted: 0, failed: 0, skippedTooLarge: 0,
      skippedBinary: 0, blockedDlp: 0, pending: 0, enrichPending: 0, chunks: 0,
    },
    filing: { unfiled: 0, suggested: 0, confirmed: 0, reassigned: 0, highConfidence: 0, queue: [] },
    activity: [],
    projects: [],
    generatedAt: '2026-07-19T12:00:00.000Z',
  };
}

function baseJob(over: Partial<DashboardJob> = {}): DashboardJob {
  return {
    id: 'job-1',
    sourceId: null,
    trigger: 'manual',
    phase: 'ingest',
    status: 'pending',
    attempts: 0,
    maxAttempts: 8,
    nextAttemptAt: '2026-07-19T12:00:00.000Z',
    lastError: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe('buildViewModel', () => {
  it('carries the ingest funnel through unchanged, and the fixture satisfies the funnel invariant', () => {
    // pending + extracted + blockedDlp + skippedTooLarge + skippedBinary = eligible
    // (failed files are also live-content rows but are not part of the
    // eligible-file partition test fixture below; kept 0 to keep the
    // invariant legible.)
    const summary = emptySummary();
    summary.sources = [{
      id: 's1', name: 'Alder Creek (dev)', kind: 'smb_share', status: 'active',
      lastCompleteRunAt: '2026-07-19T11:00:00.000Z', liveFiles: 144, liveDirs: 30,
      tombstoned: 0, newestSeenAt: '2026-07-19T11:00:00.000Z', activeRun: null,
    }];
    summary.ingest = {
      eligible: 100,
      extracted: 60,
      failed: 0,
      skippedTooLarge: 5,
      skippedBinary: 5,
      blockedDlp: 10,
      pending: 20,
      enrichPending: 12,
      chunks: 340,
    };
    const { pending, extracted, blockedDlp, skippedTooLarge, skippedBinary, eligible } = summary.ingest;
    expect(pending + extracted + blockedDlp + skippedTooLarge + skippedBinary).toBe(eligible);

    const vm = buildViewModel(summary, []);

    expect(vm.cards.coverage.funnel).toEqual({
      eligible: 100, extracted: 60, pending: 20, blockedDlp: 10,
      skippedTooLarge: 5, skippedBinary: 5, failed: 0, enrichPending: 12, chunks: 340,
    });
    expect(vm.cards.coverage.isEmpty).toBe(false);
  });

  it('renders a "retrying" banner for a pending job with a future next_attempt_at and prior attempts', () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    const job = baseJob({
      status: 'pending',
      attempts: 2,
      maxAttempts: 8,
      nextAttemptAt: '2026-07-19T12:02:00.000Z',
      lastError: 'reader: ECONNREFUSED',
    });
    const vm = buildViewModel(emptySummary(), [job], now);
    expect(vm.jobBanner).toBe('retrying (attempt 2/8): reader: ECONNREFUSED');
  });

  it('renders a "failed after N attempts" banner for a failed job', () => {
    const job = baseJob({
      status: 'failed',
      attempts: 8,
      maxAttempts: 8,
      lastError: 'reader: ECONNREFUSED',
      finishedAt: '2026-07-19T12:10:00.000Z',
    });
    const vm = buildViewModel(emptySummary(), [job]);
    expect(vm.jobBanner).toBe('failed after 8 attempts: reader: ECONNREFUSED');
  });

  it('does not treat a freshly-queued pending job (0 attempts, due now) as retrying', () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    const job = baseJob({ status: 'pending', attempts: 0, nextAttemptAt: '2026-07-19T11:59:00.000Z' });
    const vm = buildViewModel(emptySummary(), [job], now);
    expect(vm.jobBanner).toBeNull();
  });

  it('surfaces a running-job banner when no job has failed or is retrying', () => {
    const job = baseJob({ status: 'running', phase: 'enrich', attempts: 1 });
    const vm = buildViewModel(emptySummary(), [job]);
    expect(vm.jobBanner).toBe('running: enrich');
  });

  it('flags every card empty for an all-zero summary and no jobs', () => {
    const vm = buildViewModel(emptySummary(), []);
    expect(vm.cards.coverage.isEmpty).toBe(true);
    expect(vm.cards.unfiledMail.isEmpty).toBe(true);
    expect(vm.cards.recentActivity.isEmpty).toBe(true);
    expect(vm.cards.projects.isEmpty).toBe(true);
    expect(vm.jobBanner).toBeNull();
    expect(vm.jobsStrip).toEqual([]);
    expect(vm.generatedAt).toBe('2026-07-19T12:00:00.000Z');
  });

  it('caps the unfiled queue passthrough and reports counts + high confidence', () => {
    const summary = emptySummary();
    summary.filing = {
      unfiled: 23,
      suggested: 20,
      confirmed: 2,
      reassigned: 1,
      highConfidence: 9,
      queue: [
        { id: 'f1', name: 'a.eml', relPath: 'Inbox/a.eml', suggestedProjectLabel: 'Henderson', confidence: 'high' },
      ],
    };
    const vm = buildViewModel(summary, []);
    expect(vm.cards.unfiledMail).toEqual({
      isEmpty: false,
      count: 23,
      highConfidence: 9,
      queue: summary.filing.queue,
    });
  });

  it('maps the projects card to filings + crosswalk strength', () => {
    const summary = emptySummary();
    summary.projects = [
      { projectKey: 'henderson', label: 'Henderson Water Main Replacement', filedEmails: 4, crosswalkEntities: 12, evidenceFiles: 30 },
    ];
    const vm = buildViewModel(summary, []);
    expect(vm.cards.projects).toEqual({
      isEmpty: false,
      items: [{ projectKey: 'henderson', label: 'Henderson Water Main Replacement', filings: 4, crosswalkStrength: 12 }],
    });
  });
});

// ---------------------------------------------------------------------------
// Element-level smoke: registration + one host-context render, mirroring
// sourcesPage.test's environment/setup (happy-dom). Reaching the DOM only
// through textContent is the base element's load-bearing rule; the injection
// case pins it for the ported dashboard too.
// ---------------------------------------------------------------------------

const ORG_ID = 'org-1';

function pageContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    extensionName: 'workspace',
    path: '/extensions/workspace/dashboard',
    organizationId: ORG_ID,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function populatedSummary(): DashboardSummary {
  const summary = emptySummary();
  summary.sources = [{
    id: 's1', name: 'Alder Creek (dev)', kind: 'smb_share', status: 'active',
    lastCompleteRunAt: '2026-07-19T11:00:00.000Z', liveFiles: 144, liveDirs: 30,
    tombstoned: 0, newestSeenAt: '2026-07-19T11:00:00.000Z', activeRun: null,
  }];
  summary.ingest.chunks = 340;
  return summary;
}

async function mountDashboard(context: Record<string, unknown> = pageContext()): Promise<WorkspaceDashboard> {
  const element = document.createElement('workspace-dashboard') as WorkspaceDashboard;
  document.body.append(element);
  element.context = context;
  await element.updateComplete;
  return element;
}

describe('workspace-dashboard element', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    defineWorkspaceElements();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/summary')) return jsonResponse(populatedSummary());
      if (url.includes('/dashboard/jobs')) return jsonResponse({ jobs: [] });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('registers the workspace-dashboard custom element idempotently', () => {
    defineWorkspaceElements();
    expect(customElements.get('workspace-dashboard')).toBe(WorkspaceDashboard);
  });

  it('reads its org-scoped summary same-origin under the extension namespace', async () => {
    await mountDashboard();
    const summaryCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/dashboard/summary'));
    expect(summaryCall, JSON.stringify(fetchMock.mock.calls)).toBeDefined();
    const [url, init] = summaryCall as [string, RequestInit];
    expect(url).toBe(`/api/v1/ext/workspace/dashboard/summary?orgId=${ORG_ID}`);
    expect(init.credentials).toBe('same-origin');
  });

  it('renders the coverage card from the fetched summary', async () => {
    const element = await mountDashboard();
    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Coverage & freshness');
    expect(text).toContain('Alder Creek (dev)');
    expect(text).toContain('chunks');
  });

  it('renders an error and makes no network call for a malformed host context', async () => {
    const element = await mountDashboard(pageContext({ contractVersion: 2 }));
    expect(fetchMock).not.toHaveBeenCalled();
    const alert = element.shadowRoot?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('invalid host context');
  });
});
