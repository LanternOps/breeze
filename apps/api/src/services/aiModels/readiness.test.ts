import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { decryptMock } = vi.hoisted(() => ({ decryptMock: vi.fn() }));
vi.mock('./connectionKeys', () => ({ decryptConnectionKey: decryptMock }));

import { chatReadinessCode, connectionKeyUsable, type ChatReadinessFacts } from './readiness';

type ConnectionFacts = NonNullable<NonNullable<ChatReadinessFacts['defaultOffering']>['connection']>;

const base: ChatReadinessFacts = {
  orgFound: true,
  platformConfigured: true,
  defaultOffering: { enabled: true, connection: null },
};
const conn = (over: Partial<ConnectionFacts> = {}): ChatReadinessFacts => ({
  ...base,
  defaultOffering: { enabled: true, connection: { kind: 'anthropic_byok', status: 'active', keyUsable: true, catalog: 'n/a', ...over } },
});

describe('chatReadinessCode', () => {
  it.each<[string, ChatReadinessFacts, ReturnType<typeof chatReadinessCode>]>([
    ['unknown org', { ...base, orgFound: false }, 'ai_unavailable'],
    ['platform default, platform key present', base, null],
    ['platform default, no platform key', { ...base, platformConfigured: false }, 'ai_not_configured'],
    ['no default for chat (or an ambiguous not-yet-bootstrapped partner)', { ...base, defaultOffering: null }, 'ai_unavailable'],
    ['default offering disabled', { ...base, defaultOffering: { enabled: false, connection: null } }, 'ai_unavailable'],
    ['connection active, key usable', conn(), null],
    ['connection active, key usable, no platform key', { ...conn(), platformConfigured: false }, null],
    ['connection errored', conn({ status: 'error' }), 'ai_unavailable'],
    ['connection soft-disconnected (#7700)', conn({ status: 'disconnected', keyUsable: false }), 'ai_unavailable'],
    ['connection in any status other than active', conn({ status: 'pending' }), 'ai_unavailable'],
    ['connection key undecryptable', conn({ keyUsable: false }), 'ai_unavailable'],
    ['catalog revision no longer maps the offering model', conn({ kind: 'catalog', catalog: 'unusable' }), 'ai_unavailable'],
    ['catalog mapped and verified', conn({ kind: 'catalog', catalog: 'ok' }), null],
    ['openai_compatible gateway active (no platform key)', { ...conn({ kind: 'openai_compatible' }), platformConfigured: false }, null],
    ['openai_compatible gateway errored', conn({ kind: 'openai_compatible', status: 'error' }), 'ai_unavailable'],
    ['openai_compatible gateway disconnected', conn({ kind: 'openai_compatible', status: 'disconnected', keyUsable: false }), 'ai_unavailable'],
  ])('%s', (_name, facts, expected) => {
    expect(chatReadinessCode(facts)).toBe(expected);
  });
});

describe('connectionKeyUsable', () => {
  beforeEach(() => {
    decryptMock.mockReset();
    decryptMock.mockReturnValue('sk-plain');
  });

  it('an Anthropic-dialect connection needs a key that decrypts', () => {
    expect(connectionKeyUsable({ id: 'c', kind: 'anthropic_byok', apiKeyEncrypted: 'enc' })).toBe(true);
    expect(connectionKeyUsable({ id: 'c', kind: 'catalog', apiKeyEncrypted: 'enc' })).toBe(true);
    expect(connectionKeyUsable({ id: 'c', kind: 'anthropic_byok', apiKeyEncrypted: null })).toBe(false);
    expect(connectionKeyUsable({ id: 'c', kind: 'catalog', apiKeyEncrypted: null })).toBe(false);
    decryptMock.mockImplementation(() => { throw new Error('bad ciphertext'); });
    expect(connectionKeyUsable({ id: 'c', kind: 'anthropic_byok', apiKeyEncrypted: 'enc' })).toBe(false);
  });

  it('a gateway connection may be keyless (no-auth gateway, W06); a stored key must still decrypt', () => {
    expect(connectionKeyUsable({ id: 'c', kind: 'openai_compatible', apiKeyEncrypted: null })).toBe(true);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(connectionKeyUsable({ id: 'c', kind: 'openai_compatible', apiKeyEncrypted: 'enc' })).toBe(true);
    decryptMock.mockImplementation(() => { throw new Error('bad ciphertext'); });
    expect(connectionKeyUsable({ id: 'c', kind: 'openai_compatible', apiKeyEncrypted: 'enc' })).toBe(false);
  });
});

it('never escapes the held connection (#6671): no runOutsideDbContext / withSystemDbAccessContext in readiness.ts', () => {
  const src = readFileSync(join(__dirname, 'readiness.ts'), 'utf8');
  expect(src).not.toMatch(/runOutsideDbContext|withSystemDbAccessContext/);
});
