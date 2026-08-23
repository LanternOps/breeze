/**
 * #3087 — Device-bound chat sessions must run org-scoped tools under the
 * DEVICE's org (ai_sessions.org_id), not the login user's org.
 *
 * Covers:
 * - buildDeviceBoundSessionAuth: org-axis narrowing, scope/partner-axis
 *   preservation (#2822 guard), site-closure preservation, defensive throw.
 * - getOrCreate wiring: the getAuth() thunk handed to createBreezeMcpServer
 *   (i.e. what every MCP tool handler sees) is narrowed for device-bound
 *   sessions — on creation AND on the per-request auth refresh — and left
 *   untouched for non-device sessions. `session.auth` stays RAW so RBAC
 *   (checkToolPermission), rate limits, and audit attribution keep resolving
 *   the login identity/role (a dual-membership partner tech must not flip to
 *   an org role just because the session is device-bound).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

const { queryMock, capturedMcpArgs } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  capturedMcpArgs: [] as Array<{ getAuth: () => unknown }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    // Only DB read on this path: the aiBudgets approvalMode lookup.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'per_step' }])),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({
  recordUsageFromSdkResult: vi.fn(() => Promise.resolve()),
  // Also consumed on the result/done path — see the note in clientLoop.test.ts.
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn((getAuth: () => unknown) => {
    capturedMcpArgs.push({ getAuth });
    return { type: 'sdk' };
  }),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (s: unknown) => s,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { StreamingSessionManager, buildDeviceBoundSessionAuth } from './streamingSessionManager';
import { buildOrgAccessClosures, dbAccessContextFromAuth } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';
import { devices } from '../db/schema';

const LOGIN_ORG = 'aaaaaaaa-1111-4222-8333-444455556666';
const DEVICE_ORG = 'bbbbbbbb-1111-4222-8333-444455556666';
const PARTNER_ID = 'cccccccc-1111-4222-8333-444455556666';
const DEVICE_ID = 'dddddddd-1111-4222-8333-444455556666';
const USER_ID = 'eeeeeeee-1111-4222-8333-444455556666';

/**
 * Partner-scope login: orgId is null (partner tokens never carry one) and
 * accessibleOrgIds lists every org under the partner — LOGIN_ORG first, which
 * is exactly what the `getOrgId(auth)` helpers fall back to (the bug).
 */
function makePartnerAuth(): AuthContext {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [LOGIN_ORG, DEVICE_ORG],
    ...buildOrgAccessClosures([LOGIN_ORG, DEVICE_ORG]),
    user: { id: USER_ID, email: 'tech@msp.example' },
  } as unknown as AuthContext;
}

const DB_SESSION = {
  orgId: DEVICE_ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

describe('buildDeviceBoundSessionAuth', () => {
  it('narrows a partner-scope login to the device org (sibling org under the same partner)', () => {
    const auth = makePartnerAuth();
    const narrowed = buildDeviceBoundSessionAuth(auth, DEVICE_ORG);

    // Org axis pinned to the DEVICE's org — org-scoped tools (manage_patches,
    // search_logs, …) now resolve the session org, never accessibleOrgIds[0].
    expect(narrowed.orgId).toBe(DEVICE_ORG);
    expect(narrowed.accessibleOrgIds).toEqual([DEVICE_ORG]);
    expect(narrowed.canAccessOrg(DEVICE_ORG)).toBe(true);
    expect(narrowed.canAccessOrg(LOGIN_ORG)).toBe(false);
    expect(narrowed.orgCondition(devices.orgId)).toEqual(eq(devices.orgId, DEVICE_ORG));

    // Partner axis preserved (#2822): scope stays 'partner' so the derived RLS
    // context keeps accessiblePartnerIds — partner-wide config tables (scripts,
    // alert templates, update rings) must NOT black out in device-bound chat.
    expect(narrowed.scope).toBe('partner');
    expect(narrowed.partnerId).toBe(PARTNER_ID);
    const dbCtx = dbAccessContextFromAuth(narrowed);
    expect(dbCtx.accessiblePartnerIds).toEqual([PARTNER_ID]);
    expect(dbCtx.currentPartnerId).toBe(PARTNER_ID);
    expect(dbCtx.accessibleOrgIds).toEqual([DEVICE_ORG]);
    expect(dbCtx.orgId).toBe(DEVICE_ORG);
    expect(dbCtx.userId).toBe(USER_ID);
  });

  it('preserves site restrictions and identity fields (narrows, never widens)', () => {
    const canAccessSite = vi.fn(() => false);
    const auth = {
      ...makePartnerAuth(),
      allowedSiteIds: ['site-1'],
      canAccessSite,
    } as unknown as AuthContext;

    const narrowed = buildDeviceBoundSessionAuth(auth, DEVICE_ORG);

    expect(narrowed.allowedSiteIds).toEqual(['site-1']);
    expect(narrowed.canAccessSite).toBe(canAccessSite);
    expect(narrowed.user).toBe(auth.user);
  });

  it('returns the same reference when the auth is already pinned to the session org', () => {
    const auth = {
      scope: 'organization',
      orgId: DEVICE_ORG,
      partnerId: PARTNER_ID,
      accessibleOrgIds: [DEVICE_ORG],
      ...buildOrgAccessClosures([DEVICE_ORG]),
      user: { id: USER_ID },
    } as unknown as AuthContext;

    expect(buildDeviceBoundSessionAuth(auth, DEVICE_ORG)).toBe(auth);
  });

  // Note: this pins query TARGETING for tool helpers (`getOrgId(auth)` now
  // resolves the device org); the RLS layer still serializes system scope as
  // unrestricted ('*'), which is fine — system scope is not tenant-bounded.
  it('narrows a system-scope auth (unrestricted) to the session org while keeping system scope', () => {
    const auth = {
      scope: 'system',
      orgId: null,
      partnerId: null,
      accessibleOrgIds: null,
      ...buildOrgAccessClosures(null),
      user: { id: USER_ID },
    } as unknown as AuthContext;

    const narrowed = buildDeviceBoundSessionAuth(auth, DEVICE_ORG);
    expect(narrowed.scope).toBe('system');
    expect(narrowed.orgId).toBe(DEVICE_ORG);
    expect(narrowed.accessibleOrgIds).toEqual([DEVICE_ORG]);
  });

  it('throws (fails loudly) when the caller cannot access the session org', () => {
    const auth = {
      scope: 'organization',
      orgId: LOGIN_ORG,
      partnerId: PARTNER_ID,
      accessibleOrgIds: [LOGIN_ORG],
      ...buildOrgAccessClosures([LOGIN_ORG]),
      user: { id: USER_ID },
    } as unknown as AuthContext;

    expect(() => buildDeviceBoundSessionAuth(auth, DEVICE_ORG)).toThrow(
      /not accessible/,
    );
  });
});

describe('getOrCreate — device-bound sessions narrow the tool-facing auth', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMcpArgs.length = 0;
    queryMock.mockImplementation(() => ({
      // Never-yielding stream: the background processor just parks.
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    }));
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('hands MCP tool handlers a device-org-pinned auth for a device-bound session', async () => {
    const rawAuth = makePartnerAuth();
    const session = await manager.getOrCreate(
      'sess-device-bound',
      { ...DB_SESSION, deviceId: DEVICE_ID },
      rawAuth,
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );

    expect(session.deviceId).toBe(DEVICE_ID);
    const toolAuth = capturedMcpArgs[0]!.getAuth() as AuthContext;
    expect(toolAuth.orgId).toBe(DEVICE_ORG);
    expect(toolAuth.accessibleOrgIds).toEqual([DEVICE_ORG]);
    expect(toolAuth.scope).toBe('partner');
    expect(toolAuth.partnerId).toBe(PARTNER_ID);
    // The getOrgId(auth) fallback that mis-scoped tools (accessibleOrgIds[0])
    // now resolves the device org either way.
    expect(toolAuth.orgId ?? toolAuth.accessibleOrgIds?.[0]).toBe(DEVICE_ORG);
    // RBAC / rate limits / audit still see the RAW login auth — narrowing must
    // not flip a dual-membership tech from their partner role to an org role.
    expect(session.auth).toBe(rawAuth);
    expect(session.toolAuth).not.toBe(rawAuth);
  });

  it('re-narrows the refreshed auth on follow-up messages (never reverts to login scope)', async () => {
    await manager.getOrCreate(
      'sess-refresh',
      { ...DB_SESSION, deviceId: DEVICE_ID },
      makePartnerAuth(),
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );

    // Second message on the same in-memory session with a fresh request auth.
    await manager.getOrCreate(
      'sess-refresh',
      { ...DB_SESSION, deviceId: DEVICE_ID },
      makePartnerAuth(),
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );

    const toolAuth = capturedMcpArgs[0]!.getAuth() as AuthContext;
    expect(toolAuth.orgId).toBe(DEVICE_ORG);
    expect(toolAuth.accessibleOrgIds).toEqual([DEVICE_ORG]);
  });

  it('leaves non-device sessions untouched (partner techs keep fleet-wide reach in general chat)', async () => {
    const auth = makePartnerAuth();
    const session = await manager.getOrCreate(
      'sess-general',
      { ...DB_SESSION, deviceId: null },
      auth,
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );

    expect(session.deviceId).toBeNull();
    expect(capturedMcpArgs[0]!.getAuth()).toBe(auth);
    expect(session.toolAuth).toBe(auth);
  });
});
