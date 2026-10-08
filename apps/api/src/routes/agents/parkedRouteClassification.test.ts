/**
 * Pre-assignment admission — route classification completeness contract.
 *
 * Every route registered on the core agent router (`agentRoutes`, mounted at
 * /api/v1/agents) must be classified for a device parked in its partner's
 * holding org:
 *
 *   allow              — on the parked allowlist (middleware/agentAuthParked.ts)
 *   deny               — agent-authenticated, refused for a parked device
 *   outside_agent_auth — never reaches agentAuthMiddleware (AGENT_AUTH_SKIP_*)
 *   middleware         — a `.use()` registration, not an endpoint
 *
 * The route list is read from the REAL Hono route table, not from source text,
 * so a route added in any sub-router — or a new sub-router mounted in index.ts —
 * shows up here. An unclassified route fails, and so does a stale entry. The
 * classification is then checked against the two predicates that enforce it:
 * `isParkedAllowedAgentPath` and `shouldSkipAgentAuth`.
 *
 * HTTP only. The agent WebSocket authenticates outside this router; its
 * refusal is pinned in routes/agentWs.test.ts ("refuses the upgrade for a
 * device parked in a holding org"), and the Helper token ingress in
 * middleware/helperAuth.test.ts. The behavioural proof — a real parked device
 * sent through every route of this table against Postgres — is
 * src/__tests__/integration/parkedAgentAdmission.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { agentRoutes, shouldSkipAgentAuth } from './index';
import { isParkedAllowedAgentPath } from '../../middleware/agentAuthParked';

type Classification = 'allow' | 'deny' | 'outside_agent_auth' | 'middleware';

const EXPECTED: Record<string, Classification> = {
  // --- middleware registrations -------------------------------------------
  // The agent-token gate itself (index.ts) and sub-router `.use('*', …)`
  // guards (role checks, body limits) — not endpoints.
  'ALL /:id/*': 'middleware',
  'ALL /*': 'middleware',

  // --- allowed for a parked device ----------------------------------------
  'POST /:id/heartbeat': 'allow',
  'POST /:id/rotate-token': 'allow',
  'POST /:id/rotate-token/confirm': 'allow',
  'GET /:id/commands': 'allow',
  'POST /:id/commands/:commandId/result': 'allow',
  'POST /:id/uninstall-intent': 'allow',

  // --- agent-authenticated, refused for a parked device -------------------
  'GET /:id/config': 'deny',
  'PUT /:id/monitoring-results': 'deny',
  'POST /:id/commands/:commandId/pam-observations': 'deny',
  'POST /:id/pam/reconciliation-bindings': 'deny',
  'PUT /:id/security/status': 'deny',
  'PUT /:id/management/posture': 'deny',
  'PUT /:id/security/recovery-keys': 'deny',
  'PUT /:id/hardware': 'deny',
  'PUT /:id/software': 'deny',
  'PUT /:id/disks': 'deny',
  'PUT /:id/network': 'deny',
  'PUT /:id/warranty-info': 'deny',
  'PUT /:id/registry-state': 'deny',
  'PUT /:id/config-state': 'deny',
  'PUT /:id/sessions': 'deny',
  'PUT /:id/patches/pending': 'deny',
  'PUT /:id/patches/installed': 'deny',
  'PUT /:id/patches': 'deny',
  'PUT /:id/connections': 'deny',
  'PUT /:id/eventlogs': 'deny',
  'PUT /:id/hardware-health': 'deny',
  'PUT /:id/time-status': 'deny',
  'PUT /:id/workloads': 'deny',
  'POST /:id/logs': 'deny',
  'POST /:id/boot-performance': 'deny',
  'POST /:id/reliability': 'deny',
  'PUT /:id/changes': 'deny',
  'PUT /:id/peripherals/events': 'deny',
  'POST /:id/elevation-requests': 'deny',
  'POST /:id/process-sample': 'deny',
  // `.use()` on a single path (unifiTelemetry.ts) — classified like its route.
  'ALL /:id/unifi-collectors': 'deny',
  'ALL /:id/unifi-telemetry': 'deny',
  'GET /:id/unifi-collectors': 'deny',
  'POST /:id/unifi-telemetry': 'deny',
  'ALL /:id/topology/adjacency': 'deny',
  'POST /:id/topology/adjacency': 'deny',
  'GET /:id/winget-bootstrap/manifest': 'deny',
  'GET /:id/winget-bootstrap/file/:name': 'deny',
  // Backup storage sessions (storageSessions.ts): a parked device has no
  // backup configuration, so it never holds a storage session.
  'POST /:id/storage-sessions/:sessionId/:op': 'deny',
  'GET /:id/storage-sessions/:sessionId/object': 'deny',

  // --- outside agent-token auth -------------------------------------------
  // Identity issuance: enrollment runs on an enrollment key, before any
  // device exists.
  'POST /enroll': 'outside_agent_auth',
  // Certificate rotation (ruled in for a parked device): own bearer auth in
  // mtls.ts, issues nothing but a certificate.
  'POST /renew-cert/challenge': 'outside_agent_auth',
  'POST /renew-cert': 'outside_agent_auth',
  'POST /renew-cert/confirm': 'outside_agent_auth',
  // User-JWT admin routes: a human with access to the device's org, which a
  // holding org never is for a human principal.
  'GET /quarantined': 'outside_agent_auth',
  'POST /:id/approve': 'outside_agent_auth',
  'POST /:id/deny': 'outside_agent_auth',
  'PATCH /org/:orgId/settings/mtls': 'outside_agent_auth',
  'GET /org/:orgId/settings/helper': 'outside_agent_auth',
  'PATCH /org/:orgId/settings/helper': 'outside_agent_auth',
  'GET /org/:orgId/settings/log-forwarding': 'outside_agent_auth',
  'PATCH /org/:orgId/settings/log-forwarding': 'outside_agent_auth',
  // Static installer/binary downloads and install scripts: no device identity.
  'GET /download/:os/:arch': 'outside_agent_auth',
  'GET /download/windows/amd64/msi': 'outside_agent_auth',
  'GET /download/:os/:arch/pkg': 'outside_agent_auth',
  'GET /download/helper/:os/:arch': 'outside_agent_auth',
  'GET /download/watchdog/:os/:arch': 'outside_agent_auth',
  'GET /download/backup/:os/:arch': 'outside_agent_auth',
  'GET /download/recovery-iso/:os/:arch': 'outside_agent_auth',
  'GET /download/user-helper/:os/:arch': 'outside_agent_auth',
  'GET /install.sh': 'outside_agent_auth',
  'GET /uninstall.sh': 'outside_agent_auth',
};

// Floor on the enumerated table (unique METHOD + path) at authoring time, so a
// broken enumeration cannot pass vacuously.
const MIN_ROUTE_COUNT = 64;

const AGENT_ID = 'agent-parked-1';
const UUID = '6f1c7a52-8d0e-4b8f-9a55-0f5a3d1c2b7e';
const MOUNT = '/api/v1/agents';

function routeTable(): string[] {
  return [...new Set(agentRoutes.routes.map((route) => `${route.method} ${route.path}`))].sort();
}

/** A concrete request path for a registered pattern. */
function materialise(pattern: string, idValue: string): string {
  const concrete = pattern
    .replace(/\/\*$/, '/anything')
    .replace(':id', idValue)
    .replace(/:[A-Za-z]+/g, (param) => (param === ':name' || param === ':os' || param === ':arch' ? 'x' : UUID));
  return `${MOUNT}${concrete}`;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

describe('parked-device route classification', () => {
  const table = routeTable();

  it('enumerates the real agent router', () => {
    expect(table.length).toBeGreaterThanOrEqual(MIN_ROUTE_COUNT);
    expect(table).toContain('POST /:id/heartbeat');
  });

  it('classifies every registered route, and nothing that is not registered', () => {
    const unclassified = table.filter((key) => !(key in EXPECTED));
    const stale = Object.keys(EXPECTED).filter((key) => !table.includes(key));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  const agentAuthed = Object.entries(EXPECTED).filter(([, cls]) => cls === 'allow' || cls === 'deny');

  it.each(agentAuthed)('%s (%s) runs behind agent-token auth and the parked matcher agrees', (key, cls) => {
    const pattern = key.slice(key.indexOf(' ') + 1);
    expect(pattern.startsWith('/:id/')).toBe(true);
    const path = materialise(pattern, AGENT_ID);
    expect(shouldSkipAgentAuth(path, AGENT_ID)).toBe(false);
    expect(isParkedAllowedAgentPath(segments(path), AGENT_ID)).toBe(cls === 'allow');
  });

  const outside = Object.entries(EXPECTED).filter(([, cls]) => cls === 'outside_agent_auth');

  it.each(outside)('%s skips agent-token auth', (key) => {
    const pattern = key.slice(key.indexOf(' ') + 1);
    const path = materialise(pattern, UUID);
    const idSegment = segments(path)[3] ?? '';
    expect(shouldSkipAgentAuth(path, idSegment)).toBe(true);
  });

  it('exactly six endpoints are open to a parked device', () => {
    expect(Object.entries(EXPECTED).filter(([, cls]) => cls === 'allow').map(([key]) => key).sort()).toEqual([
      'GET /:id/commands',
      'POST /:id/commands/:commandId/result',
      'POST /:id/heartbeat',
      'POST /:id/rotate-token',
      'POST /:id/rotate-token/confirm',
      'POST /:id/uninstall-intent',
    ]);
  });

  it.each([
    `/api/v1/ext/acme/agent/${AGENT_ID}/heartbeat`,
    `/api/v1/ext/acme/agent/${AGENT_ID}/commands`,
    `/api/v1/acme/agent/${AGENT_ID}/rotate-token`,
    `/api/v1/workspace/agent/${AGENT_ID}/crawl-config`,
  ])('extension and Workspace agent mounts are refused: %s', (path) => {
    expect(isParkedAllowedAgentPath(segments(path), AGENT_ID)).toBe(false);
  });
});
