import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ resolveModel: vi.fn(), readOrgPartnerId: vi.fn(), readSessionModelRow: vi.fn() }));
vi.mock('./resolveModel', async (orig) => ({ ...(await orig<typeof import('./resolveModel')>()), resolveModel: m.resolveModel }));
vi.mock('./candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId, readSessionModelRow: m.readSessionModelRow }));

import { resolveSessionTurn } from './sessionModel';

beforeEach(() => {
  vi.clearAllMocks();
  m.readOrgPartnerId.mockResolvedValue('partner-1');
  m.resolveModel.mockResolvedValue({ ok: true });
});

describe('resolveSessionTurn', () => {
  it('re-resolves the stored offering + options as a session-origin request (bounded fallback applies)', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: 'off-9', options: { effort: 'high' } });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' });
    expect(m.resolveModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: 'u1', surface: 'chat',
      requested: { offeringId: 'off-9', options: { effort: 'high' }, origin: 'session' },
    });
  });

  it('a session with no stored offering resolves the effective default', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null });
    await resolveSessionTurn({ sessionId: 's1', surface: 'helper', userId: null });
    expect(m.resolveModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: null, surface: 'helper',
    });
  });

  it('passes maxTokens and transport through', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: null, maxTokens: 512, transport: 'agent_sdk' });
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 512, transport: 'agent_sdk' }));
  });

  it('an org with no partner has no assignment to resolve', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null });
    m.readOrgPartnerId.mockResolvedValue(null);
    expect(await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' }))
      .toMatchObject({ ok: false, reason: 'no_eligible_model', recoverable: true });
    expect(m.resolveModel).not.toHaveBeenCalled();
  });

  it('a missing session throws (callers map it to their own not-found)', async () => {
    m.readSessionModelRow.mockResolvedValue(null);
    await expect(resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' })).rejects.toThrow(/not found/);
  });
});
