import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  auth: null as null | Record<string, unknown>,
  permissions: new Set<string>(),
  getSession: vi.fn(),
  readOrgPartnerId: vi.fn(async (_o: string): Promise<string | null> => 'p1'),
  listModelChoices: vi.fn(async (i: Record<string, unknown>) => ({ surface: i.surface, allowUserChoice: true, defaultOfferingId: null, choices: [], current: i.current ?? null })),
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes((m.auth as { scope: string }).scope)) return c.json({ error: 'forbidden' }, 403);
    c.set('auth', m.auth); return next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (m.permissions.has(`${resource}:${action}`) ? next() : c.json({ error: 'forbidden' }, 403)),
  withAuthDbAccessContext: (_a: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../services/aiAgent', () => ({ getSession: m.getSession }));
vi.mock('../../services/aiModels/candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId }));
vi.mock('../../services/aiModels/modelChoices', () => ({ listModelChoices: m.listModelChoices }));

import { aiModelChoiceRoutes } from './choices';
import { LlmUnavailableError } from '../../services/llm/llmUnavailableError';

const ORG = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0b01';
const OTHER_ORG = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0b02';
const SESSION = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0c01';

function app() { return new Hono().route('/ai/models/choices', aiModelChoiceRoutes); }
function orgAuth(over: Record<string, unknown> = {}) {
  return { scope: 'organization', orgId: ORG, partnerId: 'p1', user: { id: 'u1' }, canAccessOrg: (o: string) => o === ORG, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auth = orgAuth();
  m.permissions = new Set(['ai_sessions:use', 'ai_agents:read']);
  m.readOrgPartnerId.mockImplementation(async () => 'p1');
});

describe('GET /ai/models/choices/chat', () => {
  it('requires ai_sessions:use', async () => {
    m.permissions = new Set();
    expect((await app().request('/ai/models/choices/chat')).status).toBe(403);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
  it('defaults to the caller\'s org and the caller as the user', async () => {
    const res = await app().request('/ai/models/choices/chat');
    expect(res.status).toBe(200);
    expect(m.listModelChoices).toHaveBeenCalledWith({ partnerId: 'p1', orgId: ORG, userId: 'u1', surface: 'chat', current: null });
  });
  it('a session the caller does not own is an opaque 404 (owner-bound getSession)', async () => {
    m.getSession.mockResolvedValueOnce(null);
    expect((await app().request(`/ai/models/choices/chat?sessionId=${SESSION}`)).status).toBe(404);
    expect(m.listModelChoices).not.toHaveBeenCalled();
    // Owner-bound: never the allowAnyOwnerInOrg read.
    expect(m.getSession).toHaveBeenCalledWith(SESSION, m.auth);
  });
  it('a session passes its org and its stamped choice as current', async () => {
    m.getSession.mockResolvedValueOnce({ id: SESSION, orgId: ORG, offeringId: 'off-1', options: { effort: 'high' } });
    await app().request(`/ai/models/choices/chat?sessionId=${SESSION}`);
    expect(m.listModelChoices).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, current: { offeringId: 'off-1', options: { effort: 'high' } } }));
  });
  it('a session with no stamped model yet passes a null current choice', async () => {
    m.getSession.mockResolvedValueOnce({ id: SESSION, orgId: ORG, offeringId: null, options: null });
    await app().request(`/ai/models/choices/chat?sessionId=${SESSION}`);
    expect(m.listModelChoices).toHaveBeenCalledWith(expect.objectContaining({ current: { offeringId: null, options: null } }));
  });
  it('an org the caller cannot access is an opaque 404', async () => {
    expect((await app().request(`/ai/models/choices/chat?orgId=${OTHER_ORG}`)).status).toBe(404);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
  it('a partner-scope caller asking for an org of another partner is a 404', async () => {
    m.auth = orgAuth({ scope: 'partner', orgId: null, canAccessOrg: () => true });
    m.readOrgPartnerId.mockResolvedValueOnce('p2');
    expect((await app().request(`/ai/models/choices/chat?orgId=${OTHER_ORG}`)).status).toBe(404);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
  it('an org that does not exist is a 404', async () => {
    m.readOrgPartnerId.mockResolvedValueOnce(null);
    expect((await app().request('/ai/models/choices/chat')).status).toBe(404);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
  it('no org context at all is a 400', async () => {
    m.auth = orgAuth({ scope: 'partner', orgId: null });
    expect((await app().request('/ai/models/choices/chat')).status).toBe(400);
  });
  it('a session AND an org is a 400 (one context only)', async () => {
    expect((await app().request(`/ai/models/choices/chat?sessionId=${SESSION}&orgId=${ORG}`)).status).toBe(400);
    expect(m.getSession).not.toHaveBeenCalled();
  });
  it('a registry cutover in progress is a 503 the client can retry', async () => {
    m.listModelChoices.mockRejectedValueOnce(new LlmUnavailableError('AI configuration is being upgraded. Try again in a moment.'));
    const res = await app().request('/ai/models/choices/chat');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'registry_unavailable' });
  });
});

describe('GET /ai/models/choices/ai-agents', () => {
  it('requires ai_agents:read', async () => {
    m.permissions = new Set(['ai_sessions:use']);
    expect((await app().request(`/ai/models/choices/ai-agents?orgId=${ORG}`)).status).toBe(403);
  });
  it('an org agent lists for that org', async () => {
    await app().request(`/ai/models/choices/ai-agents?orgId=${ORG}`);
    expect(m.listModelChoices).toHaveBeenCalledWith({ partnerId: 'p1', orgId: ORG, userId: 'u1', surface: 'ai_agents' });
  });
  it('an org the caller cannot access is an opaque 404', async () => {
    expect((await app().request(`/ai/models/choices/ai-agents?orgId=${OTHER_ORG}`)).status).toBe(404);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
  it('a partner-scope caller asking for an org of another partner is a 404', async () => {
    m.auth = orgAuth({ scope: 'partner', orgId: null, canAccessOrg: () => true });
    m.readOrgPartnerId.mockResolvedValueOnce('p2');
    expect((await app().request(`/ai/models/choices/ai-agents?orgId=${OTHER_ORG}`)).status).toBe(404);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
  it('a partner-wide agent (no org) is partner scope only', async () => {
    expect((await app().request('/ai/models/choices/ai-agents')).status).toBe(400);
    m.auth = orgAuth({ scope: 'partner', orgId: null });
    await app().request('/ai/models/choices/ai-agents');
    expect(m.listModelChoices).toHaveBeenCalledWith({ partnerId: 'p1', orgId: null, userId: 'u1', surface: 'ai_agents' });
  });
  it('a system-scope caller with no partner cannot list partner-wide agent models', async () => {
    m.auth = orgAuth({ scope: 'system', orgId: null, partnerId: null, canAccessOrg: () => true });
    expect((await app().request('/ai/models/choices/ai-agents')).status).toBe(400);
    expect(m.listModelChoices).not.toHaveBeenCalled();
  });
});
