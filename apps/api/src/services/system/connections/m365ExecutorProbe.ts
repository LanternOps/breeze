/**
 * Reachability probe for the two Microsoft 365 Graph executors (#9324).
 *
 * "Enabled" on System → Connections only means the env vars are set. This
 * checks, per configured executor: `GET /healthz`, that each required
 * `/v1/*` route exists, and the build identity from `GET /version`.
 *
 * Safety:
 * - Only the operator-configured executor URL from the env is contacted; no
 *   caller input reaches a URL (no SSRF).
 * - Route presence is probed with an UNAUTHENTICATED POST: a deployed route
 *   answers 401, a pre-wave image answers 404. No credentials are sent.
 * - Short timeout, no redirects. Response bodies are never echoed: only
 *   status codes and two regex-validated build labels leave this module, and
 *   neither error text nor the URL does.
 */
import type { EnvSnapshot } from '../../../system/connections/types';

export const PROBE_TIMEOUT_MS = 3000;

export type RouteState = 'present' | 'missing' | 'unknown';

export interface ExecutorProbeResult {
  id: 'm365-graph-read' | 'm365-graph-actions';
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  routes: Record<string, RouteState>;
  version: { version: string; gitSha: string } | null;
  /** null when either side does not report a version. */
  versionMatchesApi: boolean | null;
}

export interface M365ExecutorProbeReport {
  executors: ExecutorProbeResult[];
}

interface ExecutorTarget {
  id: ExecutorProbeResult['id'];
  urlVar: string;
  routes: readonly string[];
}

const TARGETS: readonly ExecutorTarget[] = [
  {
    id: 'm365-graph-read',
    urlVar: 'M365_GRAPH_READ_EXECUTOR_URL',
    routes: ['verify-identity', 'retest', 'read-action', 'sync-action'],
  },
  {
    id: 'm365-graph-actions',
    urlVar: 'M365_GRAPH_ACTIONS_EXECUTOR_URL',
    routes: ['verify-identity', 'retest', 'execute-action'],
  },
];

const BUILD_LABEL = /^[A-Za-z0-9._+-]{1,64}$/;

function baseUrl(raw: string | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value.endsWith('/') ? value : `${value}/`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function request(base: URL, path: string, init: RequestInit): Promise<Response> {
  return fetch(new URL(path, base), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

async function probeRoute(base: URL, route: string): Promise<RouteState> {
  try {
    const res = await request(base, `v1/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // 404 is a pre-wave image. Any other answer means the router matched the
    // path: 401 (expected), 400/403/415 from an earlier gate, even a 5xx.
    return res.status === 404 ? 'missing' : 'present';
  } catch {
    return 'unknown';
  }
}

async function probeVersion(base: URL): Promise<{ version: string; gitSha: string } | null> {
  try {
    const res = await request(base, 'version', { method: 'GET' });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { version?: unknown; gitSha?: unknown } | null;
    const version = typeof body?.version === 'string' ? body.version : '';
    const gitSha = typeof body?.gitSha === 'string' ? body.gitSha : '';
    if (!BUILD_LABEL.test(version) || !BUILD_LABEL.test(gitSha)) return null;
    return { version, gitSha };
  } catch {
    return null;
  }
}

async function probeOne(target: ExecutorTarget, env: EnvSnapshot): Promise<ExecutorProbeResult> {
  const base = baseUrl(env[target.urlVar]);
  const unknownRoutes = Object.fromEntries(target.routes.map((r) => [r, 'unknown' as RouteState]));
  const down = (configured: boolean): ExecutorProbeResult => ({
    id: target.id,
    configured,
    reachable: false,
    latencyMs: null,
    routes: unknownRoutes,
    version: null,
    versionMatchesApi: null,
  });
  if (!base) return down(false);

  const started = Date.now();
  let reachable = false;
  try {
    reachable = (await request(base, 'healthz', { method: 'GET' })).status === 200;
  } catch {
    reachable = false;
  }
  if (!reachable) return down(true);
  const latencyMs = Date.now() - started;

  const [version, ...states] = await Promise.all([
    probeVersion(base),
    ...target.routes.map((r) => probeRoute(base, r)),
  ]);
  const apiVersion = env.APP_VERSION?.trim();
  return {
    id: target.id,
    configured: true,
    reachable: true,
    latencyMs,
    routes: Object.fromEntries(target.routes.map((r, i) => [r, states[i] as RouteState])),
    version,
    versionMatchesApi: version && apiVersion ? version.version === apiVersion : null,
  };
}

export async function probeM365Executors(env: EnvSnapshot): Promise<M365ExecutorProbeReport> {
  return { executors: await Promise.all(TARGETS.map((t) => probeOne(t, env))) };
}
