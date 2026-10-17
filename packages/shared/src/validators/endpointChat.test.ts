import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_CHAT_LIMITS,
  ENDPOINT_CHAT_MIN_AGENT_VERSION,
  agentSupportsEndpointChat,
  endpointChatBodyIssues,
  endpointChatMessageSchema,
  endpointChatOpenSchema,
} from './endpointChat';
import * as barrel from '../index';

const conv = '11111111-1111-4111-8111-111111111111';
const dev = '22222222-2222-4222-8222-222222222222';
const msg = '33333333-3333-4333-8333-333333333333';

describe('endpoint chat validators', () => {
  it('accepts an open with an initial message and trims the body', () => {
    const parsed = endpointChatOpenSchema.parse({ conversationId: conv, deviceId: dev, body: '  Hi, it is IT. Got a minute?  ' });
    expect(parsed.body).toBe('Hi, it is IT. Got a minute?');
  });

  it('rejects an empty, oversize or unsafe body on open and on message', () => {
    expect(endpointChatOpenSchema.safeParse({ conversationId: conv, deviceId: dev, body: '   ' }).success).toBe(false);
    expect(endpointChatMessageSchema.safeParse({ messageId: msg, body: 'x'.repeat(ENDPOINT_CHAT_LIMITS.bodyMax + 1) }).success).toBe(false);
    expect(endpointChatMessageSchema.safeParse({ messageId: msg, body: 'see <b>this</b>' }).success).toBe(false);
    expect(endpointChatMessageSchema.safeParse({ messageId: msg, body: 'go to [here](http://evil.example)' }).success).toBe(false);
    expect(endpointChatMessageSchema.safeParse({ messageId: msg, body: '![x](https://img.example/a.png)' }).success).toBe(false);
    expect(endpointChatMessageSchema.safeParse({ messageId: msg, body: 'status: [page](https://status.example.com)' }).success).toBe(true);
  });

  it('is strict: unknown keys (e.g. a ticket binding) are refused', () => {
    expect(endpointChatOpenSchema.safeParse({ conversationId: conv, deviceId: dev, body: 'hi', ticketId: conv }).success).toBe(false);
    expect(endpointChatMessageSchema.safeParse({ messageId: msg, body: 'hi', senderName: 'CEO' }).success).toBe(false);
  });

  it('reports body issues without the title rules', () => {
    expect(endpointChatBodyIssues('plain text with 10:30 and Note: ok')).toEqual([]);
    expect(endpointChatBodyIssues('call tel:5550100')).toContain('links must use https');
  });

  it('fails closed on the agent version gate', () => {
    expect(agentSupportsEndpointChat(null)).toBe(false);
    expect(agentSupportsEndpointChat('garbage')).toBe(false);
    expect(agentSupportsEndpointChat('0.123.0')).toBe(false);
    expect(agentSupportsEndpointChat(ENDPOINT_CHAT_MIN_AGENT_VERSION)).toBe(true);
  });

  it('is exported from the package barrel', () => {
    expect(barrel.endpointChatOpenSchema).toBe(endpointChatOpenSchema);
    expect(barrel.agentSupportsEndpointChat).toBe(agentSupportsEndpointChat);
  });
});
