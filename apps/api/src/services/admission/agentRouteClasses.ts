/**
 * W08 — which agent requests may be refused under load, and how.
 *
 * protected: never shed. Heartbeats (the agent's watchdog restarts it after
 *   3 min without a 200 — agent/internal/config/config.go:391), recovery
 *   (commands, results, token rotation, uninstall), loss-sensitive uploads
 *   (eventlogs: the collector cursor advances at collect, so a failed send is
 *   lost for good), interactive or in-progress work (elevation, backup storage
 *   sessions, winget bootstrap) and user-JWT admin routes.
 * standard: shed at level 2+. Periodic status; the agent drops, requeues or
 *   resends next cycle (monitoring-results gaps are an accepted loss).
 * bulk: shed at level 1+, and capped in flight at every level in enforce mode.
 *   Inventory snapshots, samples, logs and UniFi traffic.
 *
 * Keys are `METHOD /pattern` exactly as the core agent router registers them;
 * agentRouteClasses.test.ts fails on any registered `/:id/` endpoint missing
 * here, and on any entry here that is not registered. Routes OUTSIDE `/:id/`
 * (enroll, renew-cert, downloads, org settings) and other agent mounts
 * (extension gateway, ee/workspace crawl-config) are not classified and are
 * never shed in W08.
 */
export type AdmissionClass = 'protected' | 'standard' | 'bulk' | 'ws_upgrade';
type RouteClass = Exclude<AdmissionClass, 'ws_upgrade'>;

export interface ClassifiedRequest {
  cls: AdmissionClass;
  /** `METHOD /:id/...` key from the table (or `GET /:id/ws`). */
  key: string;
  /** Route template used as the metrics/log label. Never contains request data. */
  label: string;
}

export const AGENT_ROUTE_ADMISSION_CLASSES: Readonly<Record<string, RouteClass>> = Object.freeze({
  // protected
  'POST /:id/heartbeat': 'protected',
  'GET /:id/commands': 'protected',
  'POST /:id/commands/:commandId/result': 'protected',
  'POST /:id/commands/:commandId/pam-observations': 'protected',
  'POST /:id/pam/reconciliation-bindings': 'protected',
  'POST /:id/rotate-token': 'protected',
  'POST /:id/rotate-token/confirm': 'protected',
  'POST /:id/uninstall-intent': 'protected',
  'POST /:id/elevation-requests': 'protected',
  'PUT /:id/eventlogs': 'protected',
  'GET /:id/winget-bootstrap/manifest': 'protected',
  'GET /:id/winget-bootstrap/file/:name': 'protected',
  'POST /:id/storage-sessions/:sessionId/:op': 'protected',
  'GET /:id/storage-sessions/:sessionId/object': 'protected',
  'POST /:id/approve': 'protected',
  'POST /:id/deny': 'protected',
  // standard
  'GET /:id/config': 'standard',
  'PUT /:id/monitoring-results': 'standard',
  'PUT /:id/security/status': 'standard',
  'PUT /:id/management/posture': 'standard',
  'PUT /:id/security/recovery-keys': 'standard',
  'PUT /:id/sessions': 'standard',
  'PUT /:id/changes': 'standard',
  'PUT /:id/patches': 'standard',
  'PUT /:id/patches/pending': 'standard',
  'PUT /:id/patches/installed': 'standard',
  'PUT /:id/hardware-health': 'standard',
  'PUT /:id/time-status': 'standard',
  'PUT /:id/peripherals/events': 'standard',
  'POST /:id/boot-performance': 'standard',
  'POST /:id/reliability': 'standard',
  'POST /:id/topology/adjacency': 'standard',
  // Periodic workload report (added after the plan baseline); no agent sender yet.
  'PUT /:id/workloads': 'standard',
  // bulk
  'PUT /:id/hardware': 'bulk',
  'PUT /:id/software': 'bulk',
  'PUT /:id/disks': 'bulk',
  'PUT /:id/network': 'bulk',
  'PUT /:id/connections': 'bulk',
  'PUT /:id/warranty-info': 'bulk',
  'PUT /:id/registry-state': 'bulk',
  'PUT /:id/config-state': 'bulk',
  'POST /:id/process-sample': 'bulk',
  'POST /:id/logs': 'bulk',
  'GET /:id/unifi-collectors': 'bulk',
  'POST /:id/unifi-telemetry': 'bulk',
});

export const AGENT_WS_UPGRADE_ROUTE = '/api/v1/agent-ws/:id/ws';
const AGENT_ROUTE_MOUNT = '/api/v1/agents';

/**
 * Retry-After ranges (seconds), jittered uniformly per response. For shipped
 * agents any value >= 30 means "one attempt this cycle" (httputil callers run
 * under typical 15–30 s caller contexts); the ranges are the deferral W09 agents will honour
 * at loop level.
 */
export const RETRY_AFTER_SECONDS: Readonly<Record<'bulk' | 'standard', readonly [number, number]>> = Object.freeze({
  bulk: [120, 180] as const,
  standard: [60, 90] as const,
});

export const RETRY_AFTER_OVERRIDES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  // The log shipper sleeps Retry-After with no context and Stop() waits for it
  // (agent/internal/logging/shipper.go:188-193, 571-575): keep it short.
  'POST /:id/logs': [2, 4] as const,
  // Raw Do, no retry; cadence is 30 s while collectors exist and ~15 min when
  // idle (agent/internal/unifi/collector_schedule.go): the value only matters to W09 agents.
  'GET /:id/unifi-collectors': [30, 45] as const,
});

export const WS_RETRY_AFTER_BOUNDS = [5, 120] as const;

interface Template {
  method: string;
  tail: readonly string[];
  key: string;
  cls: RouteClass;
  label: string;
}

const TEMPLATES: readonly Template[] = Object.entries(AGENT_ROUTE_ADMISSION_CLASSES).map(([key, cls]) => {
  const space = key.indexOf(' ');
  const pattern = key.slice(space + 1);
  return {
    method: key.slice(0, space),
    tail: pattern.split('/').slice(2),
    key,
    cls,
    label: `${AGENT_ROUTE_MOUNT}${pattern}`,
  };
});

/**
 * O(table) with no allocation beyond one split: runs on every request before
 * anything else. Exact shapes only — an empty segment (trailing or doubled
 * slash) or an unknown action returns null, which the middleware admits.
 */
export function classifyAgentRequest(method: string, path: string): ClassifiedRequest | null {
  const segments = path.split('/');
  if (segments.length < 6 || segments[0] !== '' || segments[1] !== 'api' || segments[2] !== 'v1') return null;
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i]!.length === 0) return null;
  }
  if (segments[3] === 'agent-ws') {
    return method === 'GET' && segments.length === 6 && segments[5] === 'ws'
      ? { cls: 'ws_upgrade', key: 'GET /:id/ws', label: AGENT_WS_UPGRADE_ROUTE }
      : null;
  }
  if (segments[3] !== 'agents') return null;
  const tail = segments.slice(5);
  for (const template of TEMPLATES) {
    if (template.method !== method || template.tail.length !== tail.length) continue;
    let match = true;
    for (let i = 0; i < tail.length; i += 1) {
      const expected = template.tail[i]!;
      if (!expected.startsWith(':') && expected !== tail[i]) {
        match = false;
        break;
      }
    }
    if (match) return { cls: template.cls, key: template.key, label: template.label };
  }
  return null;
}

export function retryAfterRange(req: ClassifiedRequest): readonly [number, number] {
  const override = RETRY_AFTER_OVERRIDES[req.key];
  if (override) return override;
  if (req.cls === 'bulk' || req.cls === 'standard') return RETRY_AFTER_SECONDS[req.cls];
  return WS_RETRY_AFTER_BOUNDS;
}
