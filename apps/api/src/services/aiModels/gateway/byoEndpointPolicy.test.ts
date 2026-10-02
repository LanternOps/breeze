import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setLookupForTests } from '../../urlSafety';

const env = vi.hoisted(() => ({ hosted: true, selfHostPrivate: false }));
vi.mock('../../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../../config/env')>()),
  isHosted: () => env.hosted,
  selfHostAllowsPrivateNetwork: () => env.selfHostPrivate,
}));

import { ByoEndpointRejected, byoEgressAllowances, joinByoUrl, validateByoBaseUrl } from './byoEndpointPolicy';

function resolveTo(ip: string) {
  __setLookupForTests(async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }]);
}

describe('byoEndpointPolicy', () => {
  beforeEach(() => { env.hosted = true; env.selfHostPrivate = false; });
  afterEach(() => __setLookupForTests(null));

  it('hosted: https + public resolves', async () => {
    resolveTo('93.184.216.34');
    await expect(validateByoBaseUrl('https://llm.example.com/v1/')).resolves.toBe('https://llm.example.com/v1');
  });

  it('hosted: refuses cleartext even to a public address', async () => {
    resolveTo('93.184.216.34');
    await expect(validateByoBaseUrl('http://llm.example.com/v1')).rejects.toMatchObject({ code: 'egress_blocked' });
  });

  it.each([
    ['10.0.0.5'], ['192.168.1.10'], ['127.0.0.1'], ['169.254.169.254'], ['100.64.0.1'], ['::1'], ['fd00::1'],
  ])('hosted: refuses a host resolving to %s', async (ip) => {
    resolveTo(ip);
    await expect(validateByoBaseUrl('https://sneaky.example.com')).rejects.toBeInstanceOf(ByoEndpointRejected);
  });

  it('self-host with the private opt-in: allows http to RFC 1918', async () => {
    env.hosted = false; env.selfHostPrivate = true;
    resolveTo('192.168.1.10');
    await expect(validateByoBaseUrl('http://ollama.lan:11434/v1')).resolves.toBe('http://ollama.lan:11434/v1');
  });

  it('self-host: cleartext to a PUBLIC address is still refused (requirePrivateForCleartext)', async () => {
    env.hosted = false; env.selfHostPrivate = true;
    resolveTo('93.184.216.34');
    await expect(validateByoBaseUrl('http://llm.example.com/v1')).rejects.toMatchObject({ code: 'egress_blocked' });
  });

  it.each([['127.0.0.1'], ['169.254.169.254'], ['::1']])('self-host: loopback/metadata %s are never allowed', async (ip) => {
    env.hosted = false; env.selfHostPrivate = true;
    resolveTo(ip);
    await expect(validateByoBaseUrl('http://box.lan/v1')).rejects.toMatchObject({ code: 'egress_blocked' });
  });

  it('refuses userinfo / query / fragment as invalid_url', async () => {
    await expect(validateByoBaseUrl('https://u:p@x.example.com')).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(validateByoBaseUrl('https://x.example.com/?a=1')).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('the rejection message never echoes resolved IPs (no internal topology in errors)', async () => {
    resolveTo('10.1.2.3');
    const err = await validateByoBaseUrl('https://x.example.com').catch((e) => e as Error);
    expect(String(err.message)).not.toContain('10.1.2.3');
  });

  it('byoEgressAllowances reflects the deployment', () => {
    expect(byoEgressAllowances()).toEqual({ allowPrivateNetwork: false, requirePrivateForCleartext: true });
    env.hosted = false; env.selfHostPrivate = true;
    expect(byoEgressAllowances()).toEqual({ allowPrivateNetwork: true, requirePrivateForCleartext: true });
  });

  it('joinByoUrl', () => {
    expect(joinByoUrl('https://x.example.com/v1', 'chat/completions')).toBe('https://x.example.com/v1/chat/completions');
    expect(joinByoUrl('https://x.example.com/v1/', 'models')).toBe('https://x.example.com/v1/models');
    expect(() => joinByoUrl('https://x.example.com', '../admin')).toThrow();
  });
});
