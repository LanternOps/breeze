import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ resolveModel: vi.fn(), readOrgPartnerId: vi.fn(), readSessionModelRow: vi.fn() }));
const extra = vi.hoisted(() => ({
  findOfferingIdByModel: vi.fn(),
  isPlatformLlmConfigured: vi.fn(() => true),
  ensurePartnerCutover: vi.fn(async () => true),
}));
vi.mock('./resolveModel', async (orig) => ({ ...(await orig<typeof import('./resolveModel')>()), resolveModel: m.resolveModel }));
vi.mock('./candidateLoader', () => ({
  readOrgPartnerId: m.readOrgPartnerId,
  readSessionModelRow: m.readSessionModelRow,
  findOfferingIdByModel: extra.findOfferingIdByModel,
}));
vi.mock('../llm/llmAvailability', async (orig) => ({
  ...(await orig<typeof import('../llm/llmAvailability')>()),
  isPlatformLlmConfigured: extra.isPlatformLlmConfigured,
}));
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: extra.ensurePartnerCutover }));

import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { chooseSessionModel, InvalidSessionModelError, resolveSessionTurn } from './sessionModel';
import { LlmNotConfiguredError } from '../llm/llmAvailability';
import { LlmUnavailableError } from '../llm/llmConfigResolver';

beforeEach(() => {
  vi.clearAllMocks();
  extra.isPlatformLlmConfigured.mockReturnValue(true);
  extra.ensurePartnerCutover.mockResolvedValue(true);
  m.readOrgPartnerId.mockResolvedValue('partner-1');
  m.resolveModel.mockResolvedValue({ ok: true });
});

describe('W09 (D5): a resumed SDK session with history fails over only within its connection', () => {
  it.each([
    [{ turnCount: 3, sdkSessionId: 'sdk-1' }, 'agent_sdk', true],
    [{ turnCount: 0, sdkSessionId: 'sdk-1' }, 'agent_sdk', true],      // a persisted transcript is history
    [{ turnCount: 3, sdkSessionId: null }, 'agent_sdk', true],
    [{ turnCount: 0, sdkSessionId: null }, 'agent_sdk', false],
    [{ turnCount: 3, sdkSessionId: 'sdk-1' }, 'messages_api', false],  // a one-shot (ticket draft) sends its transcript explicitly
  ] as const)('%o on %s → sameConnectionOnly %s', async (history, transport, expected) => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'o1', offeringId: 'off', options: null, ...history });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1', transport });
    const call = m.resolveModel.mock.calls.at(-1)![0] as { sameConnectionOnly?: boolean };
    expect(call.sameConnectionOnly === true).toBe(expected);
  });

  it('the surface default transport decides when none is passed (chat = Agent SDK)', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'o1', offeringId: 'off', options: null, turnCount: 2, sdkSessionId: 'x' });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' });
    expect(m.resolveModel).toHaveBeenLastCalledWith(expect.objectContaining({ sameConnectionOnly: true }));
  });

  it('passes dispatch exclusions, cause and origin through', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'o1', offeringId: 'off', options: null, turnCount: 0, sdkSessionId: null });
    const origin = { offeringId: 'off', funding: 'platform' as const, connectionId: null };
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1', transport: 'messages_api',
      excludeOfferingIds: ['off'], failoverCause: 'overloaded', failoverOrigin: origin });
    expect(m.resolveModel).toHaveBeenLastCalledWith(expect.objectContaining({
      excludeOfferingIds: ['off'], failoverCause: 'overloaded', failoverOrigin: origin,
    }));
  });
});

describe('resolveSessionTurn', () => {
  it('re-resolves the stored offering + options as a session-origin request (bounded fallback applies)', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: 'off-9', options: { effort: 'high' }, turnCount: 0, sdkSessionId: null });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' });
    expect(m.resolveModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: 'u1', surface: 'chat',
      requested: { offeringId: 'off-9', options: { effort: 'high' }, origin: 'session' },
    });
  });

  it('a session with no stored offering resolves the effective default', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null, turnCount: 0, sdkSessionId: null });
    await resolveSessionTurn({ sessionId: 's1', surface: 'helper', userId: null });
    expect(m.resolveModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: null, surface: 'helper',
    });
  });

  it('passes maxTokens and transport through', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null, turnCount: 0, sdkSessionId: null });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: null, maxTokens: 512, transport: 'agent_sdk' });
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 512, transport: 'agent_sdk' }));
  });

  it('an org with no partner has no assignment to resolve', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null, turnCount: 0, sdkSessionId: null });
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

describe('resolveSessionTurn: a composer choice (W05)', () => {
  it('a choice is a strict USER request, overriding the stored offering and options', async () => {
    m.readSessionModelRow.mockResolvedValueOnce({ orgId: 'o1', offeringId: 'stored', options: { effort: 'low' }, turnCount: 0, sdkSessionId: null });
    m.readOrgPartnerId.mockResolvedValueOnce('p1');
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1', choice: { offeringId: 'picked', options: { effort: 'high' } } });
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      requested: { offeringId: 'picked', options: { effort: 'high' }, origin: 'user' },
    }));
  });
  it('without a choice the stored offering is a SESSION request (W03 behaviour, bounded fallback allowed)', async () => {
    m.readSessionModelRow.mockResolvedValueOnce({ orgId: 'o1', offeringId: 'stored', options: null, turnCount: 0, sdkSessionId: null });
    m.readOrgPartnerId.mockResolvedValueOnce('p1');
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' });
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ requested: { offeringId: 'stored', origin: 'session' } }));
  });
});

describe('chooseSessionModel', () => {
  const base = { partnerId: 'partner-1', orgId: 'org-1', userId: 'u1', surface: 'chat' as const };

  it('a permitted requested offering is stored with the user options and its funding', async () => {
    m.resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { offering: { id: 'off-2', displayName: 'Opus' } }));
    const c = await chooseSessionModel({ ...base, offeringId: 'off-2', options: { effort: 'high' } });
    expect(m.resolveModel).toHaveBeenCalledWith({ ...base, requested: { offeringId: 'off-2', options: { effort: 'high' }, origin: 'user' } });
    expect(c).toMatchObject({
      offeringId: 'off-2', offeringPartnerId: 'partner-1', options: { effort: 'high' },
      model: 'claude-sonnet-5-5', billingSource: 'partner_key',
    });
  });

  it('nothing requested resolves the surface default and stores options null (follow the assignment)', async () => {
    m.resolveModel.mockResolvedValue(makeResolvedModel('platform'));
    const c = await chooseSessionModel({ ...base, surface: 'helper', userId: null });
    expect(m.resolveModel).toHaveBeenCalledWith({ ...base, surface: 'helper', userId: null });
    expect(c).toMatchObject({ offeringId: 'off-1', offeringPartnerId: 'partner-1', options: null, billingSource: 'platform' });
  });

  it('a not-permitted / foreign offering is a 400 with the resolver reason (no fallback for a fresh choice)', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'not_permitted', recoverable: true, offeringId: 'x',
      message: 'This AI model is not available here. Choose another model.' });
    const err = await chooseSessionModel({ ...base, offeringId: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidSessionModelError);
    expect(err).toMatchObject({ name: 'InvalidSessionModelError', status: 400, code: 'not_permitted',
      message: 'This AI model is not available here. Choose another model.' });
  });

  it('a premium offering without the permission is a 400 permission_required', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'permission_required', recoverable: true, offeringId: 'p', message: 'm' });
    await expect(chooseSessionModel({ ...base, offeringId: 'p' })).rejects.toMatchObject({ status: 400, code: 'permission_required' });
  });

  it('a requested offering during the registry cutover is the retryable 503, not a 400', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'registry_unavailable', recoverable: true, offeringId: null, message: 'upgrading' });
    await expect(chooseSessionModel({ ...base, offeringId: 'off-2' })).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('chooseSessionModel has no free-form model path (W05)', async () => {
    m.resolveModel.mockResolvedValueOnce(makeResolvedModel('platform'));
    // @ts-expect-error legacyModel was removed in W05
    await chooseSessionModel({ ...base, legacyModel: 'x' });
    expect(extra.findOfferingIdByModel).not.toHaveBeenCalled();
  });

  it('nothing requested and nothing eligible keeps the legacy 503 shapes', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'm' });
    await expect(chooseSessionModel(base)).rejects.toBeInstanceOf(LlmUnavailableError);
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'connection_unavailable', recoverable: true, offeringId: null, message: 'm' });
    await expect(chooseSessionModel(base)).rejects.toBeInstanceOf(LlmUnavailableError);
    extra.isPlatformLlmConfigured.mockReturnValue(false);
    await expect(chooseSessionModel(base)).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});
