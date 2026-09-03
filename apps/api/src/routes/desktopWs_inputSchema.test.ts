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
// of sync with apps/viewer.
//
// Two sources feed the WS input channel (`wsSession.inputChannel.send`,
// inside `sendInputFn` in DesktopViewer.tsx — it branches on transport but
// sends the same event shape to WS and WebRTC either way):
//
//  1. Direct literal calls: `sendInputFn({ type: '<kind>', ... })` in
//     DesktopViewer.tsx (mouse/keyboard live input).
//  2. The indirect Paste Text path: DesktopViewer.tsx wires
//     `sendInput: event => sendInputFn({ ...event })` into `sendPasteText`
//     (pasteText.ts), which forwards `PasteKeyEvent` objects built by
//     `textToKeyEvents` in paste.ts. Those events never appear as a literal
//     `sendInputFn({ type: ... })` call site — an earlier version of this
//     scraper only caught `key_press` here by coincidence, via unrelated
//     live-keystroke call sites — so paste.ts is scanned directly for the
//     `type:` literals it constructs.
//
// Deliberately NOT scanned: the many other `{ type: '...' }` messages
// DesktopViewer.tsx sends over the WebRTC *control* channel via raw
// `ch.send(...)` (e.g. `list_monitors`, `set_cursor_stream`, `toggle_audio`).
// Those are WebRTC-exclusive control messages with no WS-fallback
// counterpart in `desktopMessageSchema` at all, so they're out of scope for
// this input-event coverage check.
function readTypeLiterals(source: string, re: RegExp): Set<string> {
  const kinds = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const kind = match[1];
    if (kind) kinds.add(kind);
  }
  return kinds;
}

function readViewerEmittedInputKinds(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/api/src/routes -> apps/viewer/src/...
  const viewerRoot = path.resolve(here, '../../../viewer/src');

  const desktopViewerSource = readFileSync(path.join(viewerRoot, 'components/DesktopViewer.tsx'), 'utf8');
  // Quote- and property-order-agnostic within each sendInputFn({...}) call.
  const directKinds = readTypeLiterals(
    desktopViewerSource,
    /sendInputFn\(\{[^}]*?\btype:\s*['"]([a-zA-Z_]+)['"]/g
  );

  const pasteSource = readFileSync(path.join(viewerRoot, 'lib/paste.ts'), 'utf8');
  const pasteKinds = readTypeLiterals(pasteSource, /type:\s*['"]([a-zA-Z_]+)['"]/g);

  return Array.from(new Set([...directKinds, ...pasteKinds]));
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

  // Zod strips unknown keys, so a field the Viewer sends but this schema does
  // not declare is silently dropped on the WebSocket fallback transport —
  // which is how a WebRTC-only fix for issue #3595 would quietly not apply
  // to fallback sessions.
  it.each(['key_down', 'key_up', 'key_press'])(
    'preserves the Caps Lock state carried on %s',
    (kind) => {
      for (const capsLock of [true, false]) {
        const result = desktopInputEvent.safeParse({ type: kind, key: 'a', capsLock });
        expect(result.success).toBe(true);
        expect(result.success && result.data.capsLock).toBe(capsLock);
      }
    }
  );

  it('leaves capsLock undefined when the Viewer does not state it', () => {
    const result = desktopInputEvent.safeParse({ type: 'key_down', key: 'a' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.capsLock).toBeUndefined();
  });

  it('rejects a non-boolean capsLock', () => {
    expect(desktopInputEvent.safeParse({ type: 'key_down', key: 'a', capsLock: 'yes' }).success).toBe(false);
  });
});
