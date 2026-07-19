import { create } from 'zustand';
import { helperRequest, type AgentConfig } from '../lib/helperFetch';
import { useChatStore } from './chatStore';

// ---------------------------------------------------------------------------
// Wire types (match the Workspace extension /helper/* contract)
// ---------------------------------------------------------------------------

export interface FinderFile {
  id: string;
  sourceId: string;
  deviceKey: string;
  relPath: string;
  parentPath: string;
  name: string;
  isDir: boolean;
  ext: string | null;
  size: number | null;
  mtime: string | null;
  openPath: string | null;
  score?: number;
  // Content-preview extras (present only when the backend reports the
  // contentSearch capability; absent fields render nothing).
  snippet?: string | null;
  inferredDocType?: string | null;
  inferredProjectKey?: string | null;
  inferredProjectLabel?: string | null;
  declaredProjectKey?: string | null;
  declaredProjectLabel?: string | null;
  metadataDisagreement?: boolean;
  group?: 'document' | 'email';
}

export interface FilingRecord {
  fileIndexId: string;
  relPath: string;
  name: string;
  emailMeta: { from?: string; to?: string[]; subject?: string; date?: string } | null;
  status: 'suggested' | 'confirmed' | 'reassigned' | null;
  suggestedProjectKey: string | null;
  suggestedProjectLabel: string | null;
  matchedEntityType: string | null;
  matchedEntityValue: string | null;
  confidence: 'high' | 'low' | null;
  rationale: string | null;
  decidedProjectKey: string | null;
}

export interface WorkspaceProject {
  key: string;
  label: string;
}

export type DepartmentFile = FinderFile & { lastActivityAt: string };

// ---------------------------------------------------------------------------
// Sorting (list-table column sort; File views only — Filing has its own UI)
// ---------------------------------------------------------------------------

export type View = 'search' | 'browse' | 'recents';
export type SortCol = 'name' | 'project' | 'docType' | 'mtime' | 'size';
export interface SortSpec { col: SortCol; dir: 'asc' | 'desc' }

export function sortRows(
  rows: FinderFile[],
  sort: SortSpec | null,
  opts: { dirsFirst?: boolean } = {},
): FinderFile[] {
  if (!sort) return rows;
  const val = (r: FinderFile): string | number => {
    switch (sort.col) {
      case 'name': return r.name.toLowerCase();
      case 'project': return (r.inferredProjectLabel ?? '').toLowerCase();
      case 'docType': return (r.inferredDocType ?? '').toLowerCase();
      case 'mtime': return Date.parse(r.mtime ?? '') || 0;
      case 'size': return r.size ?? 0;
    }
  };
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (opts.dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const av = val(a), bv = val(b);
    return av < bv ? -sign : av > bv ? sign : 0;
  });
}

export interface WorkspaceSource {
  id: string;
  displayName: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// Filter chips (Search view; content-preview fields are absent when the flag
// is off, so those chips simply have nothing to list).
// ---------------------------------------------------------------------------

export interface WorkspaceFilters {
  project?: string;
  docType?: string;
  dateFrom?: string;
  dateTo?: string;
  sourceId?: string;
  kind?: string;
}

/**
 * Pure query-param builder for /helper/search: dateFrom/dateTo become
 * modifiedAfter/modifiedBefore (ISO datetimes, as the extension's schema
 * requires), kind becomes ext (the wire field name), everything else passes
 * through unchanged. Insertion order matches the filters' declared order.
 */
export function buildSearchParams(q: string, filters: WorkspaceFilters = {}): URLSearchParams {
  const params = new URLSearchParams({ q });
  if (filters.sourceId) params.set('sourceId', filters.sourceId);
  if (filters.kind) params.set('ext', filters.kind);
  if (filters.project) params.set('project', filters.project);
  if (filters.docType) params.set('docType', filters.docType);
  if (filters.dateFrom) params.set('modifiedAfter', new Date(filters.dateFrom).toISOString());
  if (filters.dateTo) params.set('modifiedBefore', new Date(filters.dateTo).toISOString());
  return params;
}

export type ActivityAction = 'open' | 'reveal' | 'copy_path';

interface WorkspaceState {
  available: boolean | null; // null = not probed; false = hide UI
  features: string[];
  // Content preview (dev estates only): null = not probed, false = absent.
  // Gates snippets/inferred-metadata rendering and the Filing tab.
  contentEnabled: boolean | null;
  contentFeatures: string[];
  sources: WorkspaceSource[];
  results: FinderFile[];
  entries: FinderFile[];
  recent: FinderFile[];
  department: DepartmentFile[];
  filings: FilingRecord[];
  projects: WorkspaceProject[];
  loading: boolean;
  error: string | null;
  filingBusy: string | null; // fileIndexId being classified/assigned
  browsePath: { sourceId: string; parentPath: string } | null;
  sort: Record<View, SortSpec | null>;
  filters: WorkspaceFilters;

  probe: () => Promise<void>;
  search: (q: string, filters?: WorkspaceFilters) => Promise<void>;
  browse: (sourceId: string, parentPath: string) => Promise<void>;
  loadRecents: (helperUser: string | null) => Promise<void>;
  recordActivity: (
    fileIndexId: string,
    action: ActivityAction,
    helperUser: string | null,
  ) => Promise<void>;
  loadFilings: () => Promise<void>;
  classifyEmail: (fileIndexId: string) => Promise<void>;
  assignFiling: (fileIndexId: string, projectKey: string, helperUser: string | null) => Promise<void>;
  setSort: (view: View, col: SortCol) => void;
  setFilter: <K extends keyof WorkspaceFilters>(key: K, value: WorkspaceFilters[K]) => void;
  clearFilter: (key: keyof WorkspaceFilters) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentConfig(): AgentConfig | null {
  return useChatStore.getState().agentConfig;
}

function workspaceUrl(config: AgentConfig, path: string, params?: URLSearchParams): string {
  const qs = params && params.size > 0 ? `?${params.toString()}` : '';
  return `${config.api_url}/api/v1/workspace/helper${path}${qs}`;
}

function parseErrorBody(body: string, fallback: string): string {
  try {
    const data = JSON.parse(body) as { error?: unknown };
    return typeof data.error === 'string' && data.error ? data.error : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  available: null,
  features: [],
  contentEnabled: null,
  contentFeatures: [],
  sources: [],
  results: [],
  entries: [],
  recent: [],
  department: [],
  filings: [],
  projects: [],
  loading: false,
  error: null,
  filingBusy: null,
  browsePath: null,
  filters: {},
  sort: { search: null, browse: { col: 'name', dir: 'asc' }, recents: { col: 'mtime', dir: 'desc' } },

  probe: async () => {
    const config = agentConfig();
    if (!config) return;

    try {
      const res = await helperRequest(config, workspaceUrl(config, '/capabilities'), {
        method: 'GET',
      });

      if (!res.ok) {
        // Extension absent or token rejected — hide the UI, say nothing.
        set({ available: false });
        return;
      }

      const data = JSON.parse(res.body) as { ok?: boolean; features?: string[] };
      set({ available: true, features: data.features ?? [] });

      // Best-effort source list for the Browse rail and search filter.
      const srcRes = await helperRequest(config, workspaceUrl(config, '/sources'), {
        method: 'GET',
      });
      if (srcRes.ok) {
        const srcData = JSON.parse(srcRes.body) as { sources?: WorkspaceSource[] };
        set({ sources: srcData.sources ?? [] });
      }

      // Content-preview probe: 404 simply means the preview is off — silent.
      try {
        const contentRes = await helperRequest(
          config, workspaceUrl(config, '/content/capabilities'), { method: 'GET' },
        );
        if (contentRes.ok) {
          const contentData = JSON.parse(contentRes.body) as { features?: string[] };
          set({ contentEnabled: true, contentFeatures: contentData.features ?? [] });
        } else {
          set({ contentEnabled: false });
        }
      } catch {
        set({ contentEnabled: false });
      }
    } catch {
      // Probe is silent by design: no error surfaced, view stays hidden.
      set({ available: false });
    }
  },

  search: async (q, filters) => {
    const config = agentConfig();
    if (!config) return;

    const params = buildSearchParams(q, filters);

    set({ loading: true, error: null });

    try {
      const res = await helperRequest(config, workspaceUrl(config, '/search', params), {
        method: 'GET',
      });

      if (!res.ok) {
        set({ loading: false, error: parseErrorBody(res.body, 'Search is unavailable right now.') });
        return;
      }

      const data = JSON.parse(res.body) as { results?: FinderFile[] };
      set({ results: data.results ?? [], loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Search is unavailable right now.',
      });
    }
  },

  browse: async (sourceId, parentPath) => {
    const config = agentConfig();
    if (!config) return;

    const params = new URLSearchParams({ sourceId, parentPath });

    set({ loading: true, error: null });

    try {
      const res = await helperRequest(config, workspaceUrl(config, '/browse', params), {
        method: 'GET',
      });

      if (!res.ok) {
        set({ loading: false, error: parseErrorBody(res.body, "Couldn't open this folder.") });
        return;
      }

      const data = JSON.parse(res.body) as { entries?: FinderFile[] };
      set({
        entries: data.entries ?? [],
        browsePath: { sourceId, parentPath },
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Couldn't open this folder.",
      });
    }
  },

  loadRecents: async (helperUser) => {
    const config = agentConfig();
    if (!config) return;

    const params = new URLSearchParams();
    if (helperUser) params.set('helperUser', helperUser);

    set({ loading: true, error: null });

    try {
      const res = await helperRequest(config, workspaceUrl(config, '/recents', params), {
        method: 'GET',
      });

      if (!res.ok) {
        set({ loading: false, error: parseErrorBody(res.body, "Couldn't load recent files.") });
        return;
      }

      const data = JSON.parse(res.body) as {
        recent?: FinderFile[];
        department?: DepartmentFile[];
      };
      set({ recent: data.recent ?? [], department: data.department ?? [], loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Couldn't load recent files.",
      });
    }
  },

  recordActivity: async (fileIndexId, action, helperUser) => {
    const config = agentConfig();
    if (!config) return;

    try {
      await helperRequest(config, workspaceUrl(config, '/activity'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileIndexId,
          action,
          ...(helperUser ? { helperUser } : {}),
        }),
      });
    } catch (err) {
      // Best-effort: activity logging must never break the finder UI.
      console.error('[Helper] Failed to record workspace activity:', err);
    }
  },

  loadFilings: async () => {
    const config = agentConfig();
    if (!config) return;
    set({ loading: true, error: null });
    try {
      const [filingRes, projectsRes] = await Promise.all([
        helperRequest(config, workspaceUrl(config, '/filing'), { method: 'GET' }),
        helperRequest(config, workspaceUrl(config, '/content/projects'), { method: 'GET' }),
      ]);
      if (!filingRes.ok) {
        set({ loading: false, error: parseErrorBody(filingRes.body, "Couldn't load unfiled mail.") });
        return;
      }
      const filingData = JSON.parse(filingRes.body) as { filings?: FilingRecord[] };
      const projectsData = projectsRes.ok
        ? (JSON.parse(projectsRes.body) as { projects?: WorkspaceProject[] })
        : {};
      set({
        filings: filingData.filings ?? [],
        projects: projectsData.projects ?? get().projects,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Couldn't load unfiled mail.",
      });
    }
  },

  classifyEmail: async (fileIndexId) => {
    const config = agentConfig();
    if (!config) return;
    set({ filingBusy: fileIndexId, error: null });
    try {
      const res = await helperRequest(config, workspaceUrl(config, '/filing/classify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIndexId }),
      });
      if (!res.ok) {
        set({ filingBusy: null, error: parseErrorBody(res.body, "Couldn't sort this email.") });
        return;
      }
      const data = JSON.parse(res.body) as { filing?: FilingRecord };
      if (data.filing) {
        set({
          filings: get().filings.map((f) => (f.fileIndexId === fileIndexId ? data.filing! : f)),
          filingBusy: null,
        });
      } else {
        set({ filingBusy: null });
      }
    } catch (err) {
      set({
        filingBusy: null,
        error: err instanceof Error ? err.message : "Couldn't sort this email.",
      });
    }
  },

  assignFiling: async (fileIndexId, projectKey, helperUser) => {
    const config = agentConfig();
    if (!config) return;
    set({ filingBusy: fileIndexId, error: null });
    try {
      const res = await helperRequest(
        config,
        workspaceUrl(config, `/filing/${fileIndexId}/assign`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectKey, ...(helperUser ? { helperUser } : {}) }),
        },
      );
      if (!res.ok) {
        set({ filingBusy: null, error: parseErrorBody(res.body, "Couldn't move this email.") });
        return;
      }
      const data = JSON.parse(res.body) as { filing?: FilingRecord };
      if (data.filing) {
        set({
          filings: get().filings.map((f) => (f.fileIndexId === fileIndexId ? data.filing! : f)),
          filingBusy: null,
        });
      } else {
        set({ filingBusy: null });
      }
    } catch (err) {
      set({
        filingBusy: null,
        error: err instanceof Error ? err.message : "Couldn't move this email.",
      });
    }
  },

  setSort: (view, col) => {
    const current = get().sort[view];
    const dir: 'asc' | 'desc' = current && current.col === col
      ? (current.dir === 'asc' ? 'desc' : 'asc')
      : 'asc';
    set({ sort: { ...get().sort, [view]: { col, dir } } });
  },

  setFilter: (key, value) => {
    set({ filters: { ...get().filters, [key]: value } });
  },

  clearFilter: (key) => {
    const next = { ...get().filters };
    delete next[key];
    set({ filters: next });
  },
}));
