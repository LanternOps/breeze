import { beforeEach, describe, expect, it, vi } from 'vitest';

// The screen tools (take_screenshot, analyze_screen, computer_control) honour
// the device's remote-access consent policy: before anything is dispatched to
// the agent, the shared screen-access consent gate runs, and a refusal is
// returned to the model as a stable { error, code } result with no command
// sent. Devices whose policy does not require consent are unchanged.

const { checkScreenAccessConsentGate } = vi.hoisted(() => ({
  checkScreenAccessConsentGate: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
}));

vi.mock('../routes/remote/screenAccessConsentGate', () => ({ checkScreenAccessConsentGate }));

import { db } from '../db';
import { aiExecuteCommand } from './aiDispatch';
import { registerRemoteTools } from './aiToolsRemote';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';

const SCREEN_TOOLS = ['take_screenshot', 'analyze_screen', 'computer_control'] as const;

function createQueryChain(rows: any[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function tools(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerRemoteTools(reg);
  return reg;
}

function makeAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as AuthContext;
}

function inputFor(tool: string): Record<string, unknown> {
  return tool === 'computer_control'
    ? { deviceId: DEVICE_ID, action: 'left_click', x: 10, y: 10 }
    : { deviceId: DEVICE_ID };
}

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const mockExecuteCommand = aiExecuteCommand as unknown as ReturnType<typeof vi.fn>;

describe('aiToolsRemote — screen tools honour the remote-access consent policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockImplementation(() =>
      createQueryChain([
        { id: DEVICE_ID, status: 'online', siteId: null, hostname: 'host-1', orgId: ORG_ID },
      ]),
    );
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ imageBase64: 'AA==', screenshot: { imageBase64: 'AA==' } }),
    });
  });

  it.each(SCREEN_TOOLS)('%s refuses without dispatching when the device requires consent', async (name) => {
    checkScreenAccessConsentGate.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: { error: 'This device requires the user\'s consent …', code: 'CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE' },
    });

    const raw = await tools().get(name)!.handler(inputFor(name), makeAuth());
    const result = JSON.parse(raw);

    expect(result).toEqual({
      error: 'This device requires the user\'s consent …',
      code: 'CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE',
    });
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(checkScreenAccessConsentGate).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      hostname: 'host-1',
      surface: name,
    }));
  });

  it.each(SCREEN_TOOLS)('%s tells the gate whether the device is a Quick Support device', async (name) => {
    mockDb.select.mockImplementation(() =>
      createQueryChain([
        { id: DEVICE_ID, status: 'online', siteId: null, hostname: 'host-1', orgId: ORG_ID, isEphemeral: true },
      ]),
    );
    checkScreenAccessConsentGate.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: { error: 'not available on a Quick Support device', code: 'SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT' },
    });

    const result = JSON.parse(await tools().get(name)!.handler(inputFor(name), makeAuth()));

    expect(result.code).toBe('SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT');
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(checkScreenAccessConsentGate).toHaveBeenCalledWith(expect.objectContaining({ surface: name, isEphemeral: true }));
  });

  it.each(SCREEN_TOOLS)('%s refuses without dispatching when the prompt policy cannot be read', async (name) => {
    checkScreenAccessConsentGate.mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: { error: 'settings could not be read', code: 'REMOTE_PROMPT_POLICY_UNAVAILABLE' },
    });

    const result = JSON.parse(await tools().get(name)!.handler(inputFor(name), makeAuth()));

    expect(result.code).toBe('REMOTE_PROMPT_POLICY_UNAVAILABLE');
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it.each(SCREEN_TOOLS)('%s refuses without dispatching when the consent check itself throws', async (name) => {
    checkScreenAccessConsentGate.mockRejectedValueOnce(new Error('boom'));

    await expect(tools().get(name)!.handler(inputFor(name), makeAuth())).rejects.toThrow('boom');
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it.each(SCREEN_TOOLS)('%s dispatches unchanged when the device does not require consent', async (name) => {
    checkScreenAccessConsentGate.mockResolvedValueOnce({ ok: true });

    const result = JSON.parse(await tools().get(name)!.handler(inputFor(name), makeAuth()));

    expect(result.error).toBeUndefined();
    expect(result.imageBase64).toBe('AA==');
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  });

  it.each(SCREEN_TOOLS)('%s runs the consent check only for a device the caller can access', async (name) => {
    mockDb.select.mockImplementation(() => createQueryChain([]));

    const result = JSON.parse(await tools().get(name)!.handler(inputFor(name), makeAuth()));

    expect(result.error).toMatch(/not found or access denied/);
    expect(checkScreenAccessConsentGate).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it.each(SCREEN_TOOLS)('%s tells the model it is unavailable on consent-required devices', (name) => {
    expect(tools().get(name)!.definition.description).toMatch(/requires user consent/);
  });
});
