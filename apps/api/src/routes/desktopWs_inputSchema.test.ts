import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules.
// Shapes mirror desktopWs.test.ts so module resolution matches; this file
// only needs desktopInputEvent, but importing desktopWs.ts pulls in its
// full module graph.
// -------------------------------------------------------------------

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status', userId: 'remoteSessions.userId' },
  devices: { id: 'devices.id' },
  users: { id: 'users.id', status: 'users.status' },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
}));

vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: vi.fn(),
  consumeDesktopConnectCode: vi.fn(),
  createWsTicket: vi.fn(async () => ({ ticket: 'tkt' })),
  createLegacyViewerCompatibilityWsTicket: vi.fn(),
  getViewerAccessTokenExpirySeconds: vi.fn(() => 900),
}));

vi.mock('../services/jwt', () => ({
  createAccessToken: vi.fn(async () => 'mock-access-token-xyz'),
  createViewerAccessToken: vi.fn(async () => 'mock-viewer-token'),
  verifyViewerAccessToken: vi.fn(),
}));

vi.mock('../services/viewerTokenRevocation', () => ({
  isViewerJtiRevoked: vi.fn(async () => false),
  isViewerSessionRevoked: vi.fn(async () => false),
  revokeViewerSession: vi.fn(async () => undefined),
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveDesktopSessionPolicy: vi.fn().mockResolvedValue({
    clipboard: 'both',
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  }),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));

vi.mock('./remote/helpers', () => ({
  logSessionAudit: vi.fn(async () => undefined),
  getIceServers: vi.fn(() => []),
  buildRemoteSessionPromptPayload: vi.fn(async () => undefined),
}));

vi.mock('./remote/schemas', () => ({
  webrtcOfferSchema: {
    safeParse: vi.fn(),
  },
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { desktopInputEvent } from './desktopWs';

// -------------------------------------------------------------------
// Derive the real set of input kinds the Viewer emits, straight from its
// source, rather than hardcoding a list here that could silently drift out
// of sync with apps/viewer. Every `sendInputFn({ type: '<kind>', ... })`
// call site in DesktopViewer.tsx feeds the WS fallback transport
// (`wsSession.inputChannel.send`) exactly like it feeds WebRTC — see
// `sendInputFn` in that file, which branches on transport but sends the
// same event shape either way.
function readViewerEmittedInputKinds(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/api/src/routes -> apps/viewer/src/components/DesktopViewer.tsx
  const viewerPath = path.resolve(here, '../../../viewer/src/components/DesktopViewer.tsx');
  const source = readFileSync(viewerPath, 'utf8');
  const kinds = new Set<string>();
  const re = /sendInputFn\(\{\s*type:\s*'([a-z_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const kind = match[1];
    if (kind) kinds.add(kind);
  }
  return Array.from(kinds);
}

describe('desktopWs input schema — Viewer coverage', () => {
  const viewerKinds = readViewerEmittedInputKinds();

  it('source-derived extraction actually found kinds (guards against a silently-vacuous regex)', () => {
    // Sanity floor: if this regexes to zero, the parametrized assertions
    // below would vacuously pass on nothing. Fail loudly instead.
    expect(viewerKinds.length).toBeGreaterThanOrEqual(5);
    expect(viewerKinds).toEqual(
      expect.arrayContaining(['key_down', 'key_up', 'key_press', 'mouse_move', 'mouse_down', 'mouse_up', 'mouse_scroll'])
    );
  });

  it.each(readViewerEmittedInputKinds())(
    'WS schema accepts Viewer-emitted input kind %s',
    (kind) => {
      const result = desktopInputEvent.safeParse({ type: kind });
      expect(result.success).toBe(true);
    }
  );

  it('rejects an unknown/garbage input kind (schema is not just permissive)', () => {
    const result = desktopInputEvent.safeParse({ type: 'definitely_not_a_real_kind' });
    expect(result.success).toBe(false);
  });
});
