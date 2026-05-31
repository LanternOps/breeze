import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';
import { requireAgentRole } from './requireAgentRole';

type TestContext = Context & { _getResponse: () => { status: number; body: unknown } | null };

function createContext(agent?: { role: string } | undefined): TestContext {
  const store = new Map<string, unknown>();
  if (agent) store.set('agent', agent);
  let response: { status: number; body: unknown } | null = null;
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    json: (body: unknown, status?: number) => {
      response = { status: status ?? 200, body };
      return response;
    },
    _getResponse: () => response,
  } as unknown as TestContext;
}

describe('requireAgentRole', () => {
  it('rejects watchdog-role credentials with 403 and does not call next', async () => {
    const c = createContext({ role: 'watchdog' });
    const next = vi.fn();

    await requireAgentRole(c, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(c._getResponse()).toEqual({
      status: 403,
      body: { error: 'This endpoint requires the agent credential' },
    });
  });

  it('allows agent-role credentials through to next()', async () => {
    const c = createContext({ role: 'agent' });
    const next = vi.fn().mockResolvedValue(undefined);

    await requireAgentRole(c, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c._getResponse()).toBeNull();
  });

  it('rejects when no agent context is set (defense-in-depth)', async () => {
    const c = createContext(undefined);
    const next = vi.fn();

    await requireAgentRole(c, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(c._getResponse()?.status).toBe(403);
  });
});
