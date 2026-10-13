import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_MESSAGE_LIMITS,
  ENDPOINT_MESSAGING_MIN_AGENT_VERSION,
  agentSupportsEndpointMessaging,
  endpointMessageContentIssues,
  endpointMessageSendSchema,
} from './endpointMessage';
import * as barrel from '../index';

const id = '11111111-1111-4111-8111-111111111111';
const dev = '22222222-2222-4222-8222-222222222222';

function body(over: Record<string, unknown> = {}) {
  return {
    messageId: id,
    targets: { deviceIds: [dev] },
    title: 'Phones are down',
    body: 'Please call **555-0100**. Status: [status page](https://status.example.com)',
    severity: 'warning',
    requiresAck: true,
    expiresInMinutes: 60,
    ...over,
  };
}

describe('endpointMessageSendSchema', () => {
  it('accepts a valid send and defaults expiry to 24h', () => {
    const parsed = endpointMessageSendSchema.parse(body({ expiresInMinutes: undefined }));
    expect(parsed.expiresInMinutes).toBe(ENDPOINT_MESSAGE_LIMITS.defaultExpiresInMinutes);
    expect(ENDPOINT_MESSAGE_LIMITS.defaultExpiresInMinutes).toBe(1440);
  });

  it('allows null expiry (until closed) and caps explicit expiry at 168h', () => {
    expect(endpointMessageSendSchema.safeParse(body({ expiresInMinutes: null })).success).toBe(true);
    expect(endpointMessageSendSchema.safeParse(body({ expiresInMinutes: 10080 })).success).toBe(true);
    expect(endpointMessageSendSchema.safeParse(body({ expiresInMinutes: 10081 })).success).toBe(false);
    expect(endpointMessageSendSchema.safeParse(body({ expiresInMinutes: 0 })).success).toBe(false);
  });

  it('enforces title <= 120 and body <= 2000', () => {
    expect(endpointMessageSendSchema.safeParse(body({ title: 'x'.repeat(120) })).success).toBe(true);
    expect(endpointMessageSendSchema.safeParse(body({ title: 'x'.repeat(121) })).success).toBe(false);
    expect(endpointMessageSendSchema.safeParse(body({ body: 'x'.repeat(2000) })).success).toBe(true);
    expect(endpointMessageSendSchema.safeParse(body({ body: 'x'.repeat(2001) })).success).toBe(false);
    expect(endpointMessageSendSchema.safeParse(body({ title: '   ' })).success).toBe(false);
  });

  it('only accepts info|warning|critical severity', () => {
    expect(endpointMessageSendSchema.safeParse(body({ severity: 'critical' })).success).toBe(true);
    expect(endpointMessageSendSchema.safeParse(body({ severity: 'urgent' })).success).toBe(false);
  });

  it('requires a uuid messageId and at least one target', () => {
    expect(endpointMessageSendSchema.safeParse(body({ messageId: 'abc' })).success).toBe(false);
    expect(endpointMessageSendSchema.safeParse(body({ targets: {} })).success).toBe(false);
    expect(endpointMessageSendSchema.safeParse(body({ targets: { deviceIds: [] } })).success).toBe(false);
    expect(endpointMessageSendSchema.safeParse(body({ targets: { orgId: id } })).success).toBe(true);
  });

  it('rejects http: links, javascript: links, images and html', () => {
    for (const b of [
      'see [here](http://a.example)',
      'see [here](javascript:alert(1))',
      'see <http://a.example>',
      'plain http://a.example url',
      '![i](https://a.example/i.png)',
      'hello <img src=x onerror=alert(1)>',
      'hello <b>bold</b>',
      'see [x](data:text/html,hi)',
    ]) {
      expect(endpointMessageSendSchema.safeParse(body({ body: b })).success, b).toBe(false);
    }
  });

  it('accepts https links, bare https urls, bold, italic and lists', () => {
    for (const b of [
      'see [here](https://a.example/x?y=1)',
      'go to https://a.example now',
      '- one\n- two\n\n*italic* and **bold**',
      'a < b and c > d',
    ]) {
      expect(endpointMessageSendSchema.safeParse(body({ body: b })).success, b).toBe(true);
    }
  });

  it('rejects html and links in the title', () => {
    expect(endpointMessageContentIssues('<b>x</b>', 'ok').length).toBeGreaterThan(0);
    expect(endpointMessageContentIssues('[x](https://a.example)', 'ok').length).toBeGreaterThan(0);
    expect(endpointMessageContentIssues('Maintenance tonight', 'ok')).toEqual([]);
  });
});

describe('agentSupportsEndpointMessaging', () => {
  it('fails closed on null, garbage and older versions', () => {
    expect(agentSupportsEndpointMessaging(null)).toBe(false);
    expect(agentSupportsEndpointMessaging(undefined)).toBe(false);
    expect(agentSupportsEndpointMessaging('')).toBe(false);
    expect(agentSupportsEndpointMessaging('not-a-version')).toBe(false);
    expect(agentSupportsEndpointMessaging('0.0.1')).toBe(false);
  });

  it('accepts the gate version and above', () => {
    expect(agentSupportsEndpointMessaging(ENDPOINT_MESSAGING_MIN_AGENT_VERSION)).toBe(true);
    const [maj, min, pat] = ENDPOINT_MESSAGING_MIN_AGENT_VERSION.split('.').map(Number);
    expect(agentSupportsEndpointMessaging(`${maj}.${min}.${(pat ?? 0) + 1}`)).toBe(true);
  });
});

it('is exported from the package barrel', () => {
  expect(barrel.endpointMessageSendSchema).toBe(endpointMessageSendSchema);
  expect(barrel.agentSupportsEndpointMessaging).toBe(agentSupportsEndpointMessaging);
});
