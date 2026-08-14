/**
 * <workspace-dashboard> — the org-operator estate dashboard page.
 *
 * Ported from the W3 dev-harness element onto the shipped web pipeline
 * (Plan 05): it extends {@link WorkspaceBaseElement} (Shadow DOM + the shared
 * stylesheet + the disconnect AbortSignal) and reaches the DOM only through
 * `el()` — API-derived strings become `textContent`, never markup.
 *
 * Two mounts share this one element:
 *   1. Portal mount (manifest web.pages.v1) — the host assigns `context`
 *      (ExtensionPageContextV1), parsed exactly as sourcesPage.ts does, and
 *      the dashboard reads its org-scoped summary/jobs same-origin under the
 *      extension's own `/api/v1/ext/workspace/` namespace.
 *   2. Dev mount (dev/dashboard, droppable) — the `api-base` / `org-id` /
 *      `token` attributes drive a cross-origin fetch against a running dev
 *      API (the legacy `/api/v1/workspace/` namespace).
 *
 * The render model is separated from the DOM: {@link buildViewModel} is a pure
 * (summary + jobs -> view model) function, unit-tested without a host. The
 * element below is a thin templating layer over it.
 *
 * UX: calm/editorial, light default. Amber is reserved for system-state
 * signaling only (a retrying/failed/running job banner) — this surface never
 * announces "AI".
 */
import {
  parseExtensionPageContextV1,
  type ExtensionPageContextV1,
} from '@breeze/extension-web-sdk';
import { buildWorkspaceUrl } from './api';
import { WorkspaceBaseElement } from './baseElement';

// ---------------------------------------------------------------------------
// Wire types — mirror src/services/dashboardService.ts's DashboardSummary and
// src/services/ingestJobsService.ts's IngestJobRow as they arrive over JSON
// (Date fields serialize to ISO strings).
// ---------------------------------------------------------------------------

export interface DashboardSource {
  id: string; name: string; kind: string; status: string;
  lastCompleteRunAt: string | null; liveFiles: number; liveDirs: number;
  tombstoned: number; newestSeenAt: string | null;
  activeRun: { id: string; status: string; startedAt: string; stats: unknown } | null;
}

export interface DashboardIngest {
  eligible: number; extracted: number; failed: number; skippedTooLarge: number;
  skippedBinary: number; blockedDlp: number; pending: number;
  enrichPending: number; chunks: number;
}

export interface DashboardFilingQueueItem {
  id: string; name: string; relPath: string;
  suggestedProjectLabel: string | null; confidence: string | null;
}

export interface DashboardFiling {
  unfiled: number; suggested: number; confirmed: number; reassigned: number;
  highConfidence: number; queue: DashboardFilingQueueItem[];
}

export interface DashboardActivityItem {
  fileIndexId: string; name: string; relPath: string;
  lastActivityAt: string; events7d: number;
}

export interface DashboardProject {
  projectKey: string; label: string; filedEmails: number;
  crosswalkEntities: number; evidenceFiles: number;
}

export interface DashboardSummary {
  sources: DashboardSource[];
  ingest: DashboardIngest;
  filing: DashboardFiling;
  activity: DashboardActivityItem[];
  projects: DashboardProject[];
  generatedAt: string;
}

export interface DashboardJob {
  id: string;
  sourceId: string | null;
  trigger: string;
  phase: 'ingest' | 'enrich' | 'crosswalk';
  status: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// View model — the pure, unit-testable render model.
// ---------------------------------------------------------------------------

export interface CoverageSourceRow {
  id: string; name: string; kind: string; status: string;
  liveFiles: number; newestSeenAt: string | null; activeRunStatus: string | null;
}

export interface CoverageCard {
  isEmpty: boolean;
  sources: CoverageSourceRow[];
  funnel: {
    eligible: number; extracted: number; pending: number; blockedDlp: number;
    skippedTooLarge: number; skippedBinary: number; failed: number;
    enrichPending: number; chunks: number;
  };
}

export interface UnfiledMailCard {
  isEmpty: boolean;
  count: number;
  highConfidence: number;
  queue: DashboardFilingQueueItem[];
}

export interface RecentActivityCard {
  isEmpty: boolean;
  items: DashboardActivityItem[];
}

export interface ProjectsCardItem {
  projectKey: string; label: string; filings: number; crosswalkStrength: number;
}

export interface ProjectsCard {
  isEmpty: boolean;
  items: ProjectsCardItem[];
}

export interface JobsStripRow {
  id: string; status: DashboardJob['status']; phase: DashboardJob['phase'];
  attempts: number; maxAttempts: number; nextAttemptAt: string; lastError: string | null;
}

export interface DashboardViewModel {
  generatedAt: string | null;
  cards: {
    coverage: CoverageCard;
    unfiledMail: UnfiledMailCard;
    recentActivity: RecentActivityCard;
    projects: ProjectsCard;
  };
  jobBanner: string | null;
  jobsStrip: JobsStripRow[];
}

function buildJobBanner(jobs: DashboardJob[], now: Date): string | null {
  const failed = jobs.find((j) => j.status === 'failed');
  if (failed) {
    return `failed after ${failed.attempts} attempts: ${failed.lastError ?? 'unknown error'}`;
  }
  const retrying = jobs.find((j) => (
    j.status === 'pending'
    && j.attempts > 0
    && new Date(j.nextAttemptAt).getTime() > now.getTime()
  ));
  if (retrying) {
    return `retrying (attempt ${retrying.attempts}/${retrying.maxAttempts}): ${retrying.lastError ?? 'unknown error'}`;
  }
  const running = jobs.find((j) => j.status === 'running');
  if (running) {
    return `running: ${running.phase}`;
  }
  return null;
}

/** Pure: (summary, jobs) -> view model. No DOM. Unit-tested without a host. */
export function buildViewModel(
  summary: DashboardSummary,
  jobs: DashboardJob[],
  now: Date = new Date(),
): DashboardViewModel {
  const coverage: CoverageCard = {
    isEmpty: summary.sources.length === 0,
    sources: summary.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      liveFiles: s.liveFiles,
      newestSeenAt: s.newestSeenAt,
      activeRunStatus: s.activeRun ? s.activeRun.status : null,
    })),
    funnel: {
      eligible: summary.ingest.eligible,
      extracted: summary.ingest.extracted,
      pending: summary.ingest.pending,
      blockedDlp: summary.ingest.blockedDlp,
      skippedTooLarge: summary.ingest.skippedTooLarge,
      skippedBinary: summary.ingest.skippedBinary,
      failed: summary.ingest.failed,
      enrichPending: summary.ingest.enrichPending,
      chunks: summary.ingest.chunks,
    },
  };

  const unfiledMail: UnfiledMailCard = {
    isEmpty: summary.filing.unfiled === 0,
    count: summary.filing.unfiled,
    highConfidence: summary.filing.highConfidence,
    queue: summary.filing.queue,
  };

  const recentActivity: RecentActivityCard = {
    isEmpty: summary.activity.length === 0,
    items: summary.activity,
  };

  const projects: ProjectsCard = {
    isEmpty: summary.projects.length === 0,
    items: summary.projects.map((p) => ({
      projectKey: p.projectKey,
      label: p.label,
      filings: p.filedEmails,
      crosswalkStrength: p.crosswalkEntities,
    })),
  };

  return {
    generatedAt: summary.generatedAt ?? null,
    cards: { coverage, unfiledMail, recentActivity, projects },
    jobBanner: buildJobBanner(jobs, now),
    jobsStrip: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      phase: j.phase,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      nextAttemptAt: j.nextAttemptAt,
      lastError: j.lastError,
    })),
  };
}

// ---------------------------------------------------------------------------
// DOM layer.
// ---------------------------------------------------------------------------

/**
 * Dashboard-scoped stylesheet. Static string only — nothing here is ever
 * interpolated from API data, same rule as styles.ts. Appended alongside the
 * shared WORKSPACE_STYLES (the base element injects that one); clearContent
 * preserves every STYLE node, so both survive a re-render.
 */
const DASHBOARD_STYLES = `
.ws-dash {
  color: #2a2723;
  background: #f6f5f2;
  padding: 20px;
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  box-sizing: border-box;
}
.ws-dash * { box-sizing: border-box; }
.ws-banner {
  grid-column: 1 / -1;
  background: #fdf3dd;
  border: 1px solid #e8c976;
  color: #6b5217;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
}
.ws-jobs-strip {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #6b6558;
}
.ws-jobs-strip .job {
  background: #fff;
  border: 1px solid #e4e0d8;
  border-radius: 6px;
  padding: 4px 8px;
}
.ws-card {
  background: #ffffff;
  border: 1px solid #e4e0d8;
  border-radius: 10px;
  padding: 16px;
}
.ws-card h3 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #4a4638;
  text-transform: uppercase;
}
.ws-empty { color: #8a8574; font-size: 13px; }
.ws-source-row, .ws-queue-row, .ws-activity-row, .ws-project-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f0eee7;
  font-size: 13px;
}
.ws-source-row:last-child, .ws-queue-row:last-child,
.ws-activity-row:last-child, .ws-project-row:last-child { border-bottom: none; }
.ws-muted { color: #8a8574; font-size: 12px; }
.ws-funnel { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 12px; color: #6b6558; }
.ws-funnel b { color: #2a2723; }
`;

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The resolved data plane for one mount: the two endpoint URLs plus the
 * RequestInit that carries the credentials for whichever mount resolved it.
 */
interface ResolvedConfig {
  summaryUrl: string;
  jobsUrl: string;
  init: RequestInit;
}

// The dev-harness attribute mount targets a dev API's legacy namespace; the
// portal mount stays same-origin under the extension's own /ext/ namespace
// (buildWorkspaceUrl). Kept as one constant so the two mounts read alike.
const DEV_NAMESPACE = '/api/v1/workspace';

const SUMMARY_POLL_MS = 60_000;
const JOBS_POLL_MS = 10_000;

export class WorkspaceDashboard extends WorkspaceBaseElement {
  #context: ExtensionPageContextV1 | null = null;
  #summaryTimer: ReturnType<typeof setInterval> | null = null;
  #jobsTimer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;
  #lastSummary: DashboardSummary | null = null;
  #lastJobs: DashboardJob[] = [];
  #started = false;

  constructor() {
    super();
    // Append the dashboard-scoped stylesheet beside the shared one the base
    // element already injected; clearContent() preserves every STYLE node.
    const style = document.createElement('style');
    style.textContent = DASHBOARD_STYLES;
    this.root.append(style);
  }

  static get observedAttributes(): string[] {
    return ['api-base', 'org-id', 'token'];
  }

  set context(value: unknown) {
    let parsed: ExtensionPageContextV1;
    try {
      parsed = parseExtensionPageContextV1(value);
    } catch {
      this.#context = null;
      // Malformed host context: render the failure, make NO network call.
      this.renderError('Workspace received an invalid host context.');
      return;
    }
    this.#context = parsed;
    this.#restart();
  }

  get context(): ExtensionPageContextV1 | null {
    return this.#context;
  }

  connectedCallback(): void {
    // The portal mount assigns context before connect (which already started
    // the cycle); the dev mount arrives connected with attributes only.
    if (!this.#started) this.#restart();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#restart();
  }

  disconnectedCallback(): void {
    this.#stopTimers();
    this.#started = false;
    // Aborts in-flight fetches (base element contract).
    super.disconnectedCallback();
  }

  // Config resolution order: (1) host-assigned `context` (portal mount,
  // parsed to ExtensionPageContextV1) → same-origin under the extension's own
  // namespace; (2) dev-mount attributes → cross-origin against a dev API's
  // legacy namespace; (3) neither present → the missing-context state.
  #resolveConfig(): ResolvedConfig | null {
    if (this.#context) {
      return {
        summaryUrl: buildWorkspaceUrl('dashboard/summary', { orgId: this.#context.organizationId }),
        jobsUrl: buildWorkspaceUrl('dashboard/jobs', { orgId: this.#context.organizationId }),
        init: { credentials: 'same-origin' },
      };
    }
    const orgId = this.getAttribute('org-id');
    if (orgId) {
      const apiBase = this.getAttribute('api-base') ?? '';
      const token = this.getAttribute('token');
      const query = `?orgId=${encodeURIComponent(orgId)}`;
      return {
        summaryUrl: `${apiBase}${DEV_NAMESPACE}/dashboard/summary${query}`,
        jobsUrl: `${apiBase}${DEV_NAMESPACE}/dashboard/jobs${query}`,
        init: token ? { headers: { Authorization: `Bearer ${token}` } } : { credentials: 'include' },
      };
    }
    return null;
  }

  #restart(): void {
    this.#stopTimers();
    const config = this.#resolveConfig();
    if (!config) {
      this.#started = false;
      this.renderStatus(
        'Missing org context — this element needs a portal-assigned context or api-base/org-id attributes.',
      );
      return;
    }
    this.#started = true;
    this.renderStatus('Loading estate…');
    this.track(this.#refresh(config));

    // A live estate view: poll both feeds while the tab is visible. Timers are
    // torn down on disconnect (and re-armed on the next mount), so nothing
    // outlives the element.
    this.#summaryTimer = setInterval(() => {
      if (!document.hidden) void this.#fetchSummary(config);
    }, SUMMARY_POLL_MS);
    this.#jobsTimer = setInterval(() => {
      if (!document.hidden) void this.#fetchJobs(config);
    }, JOBS_POLL_MS);
    this.#visibilityHandler = () => {
      if (!document.hidden) void this.#refresh(config);
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
  }

  #stopTimers(): void {
    if (this.#summaryTimer !== null) { clearInterval(this.#summaryTimer); this.#summaryTimer = null; }
    if (this.#jobsTimer !== null) { clearInterval(this.#jobsTimer); this.#jobsTimer = null; }
    if (this.#visibilityHandler) {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  #refresh(config: ResolvedConfig): Promise<void> {
    return Promise.all([this.#fetchSummary(config), this.#fetchJobs(config)]).then(() => undefined);
  }

  #isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }

  async #fetchSummary(config: ResolvedConfig): Promise<void> {
    try {
      const res = await fetch(config.summaryUrl, { ...config.init, signal: this.signal });
      if (!res.ok) throw new Error(`summary fetch failed: ${res.status}`);
      this.#lastSummary = (await res.json()) as DashboardSummary;
      this.#paint();
    } catch (error) {
      if (this.#isAbort(error)) return;
      this.renderError('The Workspace dashboard could not be loaded.', () => {
        this.track(this.#refresh(config));
      });
    }
  }

  async #fetchJobs(config: ResolvedConfig): Promise<void> {
    try {
      const res = await fetch(config.jobsUrl, { ...config.init, signal: this.signal });
      if (!res.ok) throw new Error(`jobs fetch failed: ${res.status}`);
      const body = (await res.json()) as { jobs?: DashboardJob[] };
      this.#lastJobs = body.jobs ?? [];
      this.#paint();
    } catch (error) {
      if (this.#isAbort(error)) return;
      // A jobs-poll failure must not blank an already-rendered summary; the
      // next tick retries.
      // eslint-disable-next-line no-console
      console.error('workspace-dashboard: jobs poll failed', error);
    }
  }

  #paint(): void {
    if (!this.#lastSummary) return;
    const vm = buildViewModel(this.#lastSummary, this.#lastJobs);
    this.clearContent();
    const dash = this.el('div', { className: 'ws-dash' });
    if (vm.jobBanner) {
      dash.append(this.el('div', { className: 'ws-banner', text: vm.jobBanner, attrs: { role: 'status' } }));
    }
    dash.append(
      this.#coverageCard(vm.cards.coverage),
      this.#unfiledCard(vm.cards.unfiledMail),
      this.#activityCard(vm.cards.recentActivity),
      this.#projectsCard(vm.cards.projects),
    );
    const strip = this.#jobsStrip(vm.jobsStrip);
    if (strip) dash.append(strip);
    this.root.append(dash);
  }

  #card(title: string, children: Array<Node | string>): HTMLElement {
    return this.el('section', { className: 'ws-card' }, [this.el('h3', { text: title }), ...children]);
  }

  #empty(message: string): HTMLElement {
    return this.el('p', { text: message, className: 'ws-empty' });
  }

  #coverageCard(c: CoverageCard): HTMLElement {
    if (c.isEmpty) return this.#card('Coverage & freshness', [this.#empty('No sources yet.')]);
    const rows = c.sources.map((s) => this.el('div', { className: 'ws-source-row' }, [
      this.el('span', { text: s.activeRunStatus ? `${s.name} · running` : s.name }),
      this.el('span', { className: 'ws-muted', text: `${s.liveFiles} files · ${formatTimestamp(s.newestSeenAt)}` }),
    ]));
    return this.#card('Coverage & freshness', [...rows, this.#funnel(c.funnel)]);
  }

  #funnel(f: CoverageCard['funnel']): HTMLElement {
    const item = (label: string, value: number): HTMLElement =>
      this.el('span', {}, [`${label} `, this.el('b', { text: String(value) })]);
    return this.el('div', { className: 'ws-funnel' }, [
      item('eligible', f.eligible),
      item('extracted', f.extracted),
      item('pending', f.pending),
      item('blocked (dlp)', f.blockedDlp),
      item('skipped', f.skippedTooLarge + f.skippedBinary),
      item('failed', f.failed),
      item('enrich pending', f.enrichPending),
      item('chunks', f.chunks),
    ]);
  }

  #unfiledCard(u: UnfiledMailCard): HTMLElement {
    const title = u.isEmpty
      ? 'Unfiled mail'
      : `Unfiled mail (${u.count}, ${u.highConfidence} high-confidence)`;
    if (u.isEmpty) return this.#card(title, [this.#empty('Nothing unfiled.')]);
    const rows = u.queue.map((q) => this.el('div', { className: 'ws-queue-row' }, [
      this.el('span', { text: q.name }),
      this.el('span', {
        className: 'ws-muted',
        text: q.suggestedProjectLabel
          ? `${q.suggestedProjectLabel}${q.confidence ? ` (${q.confidence})` : ''}`
          : '—',
      }),
    ]));
    return this.#card(title, rows);
  }

  #activityCard(a: RecentActivityCard): HTMLElement {
    if (a.isEmpty) return this.#card('Recent activity', [this.#empty('No activity yet.')]);
    const rows = a.items.map((i) => this.el('div', { className: 'ws-activity-row' }, [
      this.el('span', { text: i.name }),
      this.el('span', { className: 'ws-muted', text: `${formatTimestamp(i.lastActivityAt)} · ${i.events7d}/7d` }),
    ]));
    return this.#card('Recent activity', rows);
  }

  #projectsCard(p: ProjectsCard): HTMLElement {
    if (p.isEmpty) return this.#card('Projects', [this.#empty('No projects yet.')]);
    const rows = p.items.map((i) => this.el('div', { className: 'ws-project-row' }, [
      this.el('span', { text: i.label }),
      this.el('span', { className: 'ws-muted', text: `${i.filings} filings · ${i.crosswalkStrength} crosswalk` }),
    ]));
    return this.#card('Projects', rows);
  }

  #jobsStrip(rows: JobsStripRow[]): HTMLElement | null {
    if (rows.length === 0) return null;
    const chips = rows.map((j) => this.el('span', {
      className: 'job',
      text: `${j.phase} · ${j.status} · attempt ${j.attempts}/${j.maxAttempts}${j.lastError ? ` · ${j.lastError}` : ''}`,
    }));
    return this.el('div', { className: 'ws-jobs-strip' }, chips);
  }
}
