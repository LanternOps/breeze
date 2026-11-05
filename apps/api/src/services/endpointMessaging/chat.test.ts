import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real openEndpointChat / sendEndpointChatMessage with only the edges
 * faked (DB device read, chat store, caller-scoped reads, injected deps).
 * Pins how the sender identity from brandingSnapshot reaches the dispatched
 * payload and the open outcome (#10190 W04, decision 2).
 */
const CONV = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const GENERIC = 'Your IT support team';

const h = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  insertOpening: vi.fn(),
  insertTech: vi.fn(),
  findTech: vi.fn(),
  findConversation: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (h.device ? [h.device] : []) }) }),
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../commandMinVersion', () => ({ agentSupportsChat: () => true }));
vi.mock('./chatStore', () => ({
  attachOpenCommand: vi.fn(async () => {}),
  closeLiveConversation: vi.fn(),
  conversationMessageCounts: vi.fn(),
  findTechMessage: (...a: unknown[]) => h.findTech(...a),
  insertOpeningConversation: (...a: unknown[]) => h.insertOpening(...a),
  insertTechMessage: (...a: unknown[]) => h.insertTech(...a),
  markOpenFailed: vi.fn(async () => {}),
  setMessageCommand: vi.fn(async () => {}),
  setMessageError: vi.fn(async () => null),
}));
vi.mock('./chatReads', () => ({
  chatSiteAllowed: () => true,
  conversationView: (row: Record<string, unknown>) => ({ id: row.id, status: row.status }),
  findConversationForCaller: (...a: unknown[]) => h.findConversation(...a),
  messageView: (row: Record<string, unknown>) => ({ id: row.id }),
  readConversationMessages: vi.fn(async () => []),
}));

import { defaultChatDeps, openEndpointChat, sendEndpointChatMessage, type ChatDeps } from './chat';
import { resolveMessageBranding } from './brandingSnapshot';

const now = new Date('2026-10-27T12:00:00Z');
const conversationRow = { id: CONV, orgId: ORG, deviceId: DEV, status: 'opening', allowUserReply: true, openedBy: 'u1' };
const messageRow = { id: MSG, conversationId: CONV, body: 'hi', createdAt: now, commandId: null, errorCode: null, deliveredAt: null };

const genericBrand = { partnerId: PARTNER, senderIdentity: 'generic' as const, branding: { companyName: GENERIC, displayName: GENERIC, accent: '#112233' } };
const partnerBrand = { partnerId: PARTNER, senderIdentity: 'partner' as const, branding: { companyName: 'Example IT', displayName: 'Example IT', accent: '#112233' } };

function deps(over: Partial<ChatDeps> = {}): Partial<ChatDeps> & { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async () => ({ command: { id: 'cmd-1', status: 'sent' } }));
  return {
    dispatch,
    chatSettings: async () => ({ enabled: true, allowUserReply: true }),
    branding: async () => genericBrand,
    openLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    messageLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    now: () => now,
    ...over,
  } as Partial<ChatDeps> & { dispatch: ReturnType<typeof vi.fn> };
}

const caller = (d: Partial<ChatDeps>) => ({
  auth: { user: { id: 'u1', email: 'tech@example.test', name: 'Sam' }, orgCondition: () => undefined } as never,
  deps: d,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.device = { id: DEV, orgId: ORG, siteId: 'site-1', osType: 'windows', agentVersion: '999.0.0', status: 'online' };
  h.findConversation.mockResolvedValue(null);
  h.insertOpening.mockResolvedValue({ kind: 'created', conversation: conversationRow, message: messageRow });
  h.findTech.mockResolvedValue(undefined);
  h.insertTech.mockResolvedValue({ kind: 'created', message: messageRow });
});

describe('endpoint chat sender identity (#10190 W04)', () => {
  it('the default branding dep is resolveMessageBranding (whose warn line covers every chat send)', () => {
    expect(defaultChatDeps.branding).toBe(resolveMessageBranding);
  });

  it('open under the generic sender: the outcome says so and the chat_open payload carries the generic name', async () => {
    const d = deps();
    const outcome = await openEndpointChat(caller(d), { conversationId: CONV, deviceId: DEV, body: 'hi' } as never);
    expect(outcome).toMatchObject({ ok: true, status: 202, replay: false, senderIdentity: 'generic' });
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    const [, type, payload] = d.dispatch.mock.calls[0]!;
    expect(type).toBe('chat_open');
    expect(payload.branding).toEqual({ companyName: GENERIC, displayName: GENERIC, accent: '#112233' });
  });

  it('open under the partner name says partner', async () => {
    const d = deps({ branding: async () => partnerBrand });
    const outcome = await openEndpointChat(caller(d), { conversationId: CONV, deviceId: DEV, body: 'hi' } as never);
    expect(outcome).toMatchObject({ ok: true, senderIdentity: 'partner' });
    expect(d.dispatch.mock.calls[0]![2].branding.companyName).toBe('Example IT');
  });

  it('no partner at all still fails closed: 503, nothing dispatched', async () => {
    const d = deps({ branding: async () => null });
    const outcome = await openEndpointChat(caller(d), { conversationId: CONV, deviceId: DEV, body: 'hi' } as never);
    expect(outcome).toMatchObject({ ok: false, status: 503, body: { error: 'unavailable' } });
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a follow-up chat message goes out under the generic sender (no audit row on this route; the warn line records it)', async () => {
    h.findConversation.mockResolvedValue({ conversation: { ...conversationRow, status: 'open' }, openedByName: 'Sam' });
    const d = deps();
    const outcome = await sendEndpointChatMessage(caller(d), CONV, { messageId: MSG, body: 'hi' } as never);
    expect(outcome).toMatchObject({ ok: true, status: 201 });
    const [, type, payload] = d.dispatch.mock.calls[0]!;
    expect(type).toBe('chat_message');
    expect(payload.branding).toEqual({ companyName: GENERIC, displayName: GENERIC, accent: '#112233' });
  });
});
