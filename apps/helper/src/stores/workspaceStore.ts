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
}

export type DepartmentFile = FinderFile & { lastActivityAt: string };

export interface WorkspaceSource {
  id: string;
  displayName: string;
  kind: string;
}

export type ActivityAction = 'open' | 'reveal' | 'copy_path';

interface WorkspaceState {
  available: boolean | null; // null = not probed; false = hide UI
  features: string[];
  sources: WorkspaceSource[];
  results: FinderFile[];
  entries: FinderFile[];
  recent: FinderFile[];
  department: DepartmentFile[];
  loading: boolean;
  error: string | null;
  browsePath: { sourceId: string; parentPath: string } | null;

  probe: () => Promise<void>;
  search: (q: string, filters?: { sourceId?: string; ext?: string }) => Promise<void>;
  browse: (sourceId: string, parentPath: string) => Promise<void>;
  loadRecents: (helperUser: string | null) => Promise<void>;
  recordActivity: (
    fileIndexId: string,
    action: ActivityAction,
    helperUser: string | null,
  ) => Promise<void>;
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

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  available: null,
  features: [],
  sources: [],
  results: [],
  entries: [],
  recent: [],
  department: [],
  loading: false,
  error: null,
  browsePath: null,

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
    } catch {
      // Probe is silent by design: no error surfaced, view stays hidden.
      set({ available: false });
    }
  },

  search: async (q, filters) => {
    const config = agentConfig();
    if (!config) return;

    const params = new URLSearchParams({ q });
    if (filters?.sourceId) params.set('sourceId', filters.sourceId);
    if (filters?.ext) params.set('ext', filters.ext);

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
}));
