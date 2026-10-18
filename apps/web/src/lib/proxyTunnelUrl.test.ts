import { describe, expect, it } from 'vitest';
import { HOST_MODE_SANDBOX, PATH_MODE_SANDBOX, resolveProxyTarget } from './proxyTunnelUrl';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TUNNEL = `https://${ID}.us.breezetunnel.test`;
const base = {
  tunnelId: ID,
  context: 'frame' as const,
  appOrigin: 'https://us.breeze-app.test',
  apiBase: 'https://us.breeze-app.test',
};
type Over = Partial<Omit<typeof base, 'context'>> & { context?: 'frame' | 'tab' };
const resolve = (url: unknown, over: Over = {}) => resolveProxyTarget({ ...base, ...over, url });

describe('resolveProxyTarget — host mode', () => {
  it('accepts the exact frame enter URL for this tunnel', () => {
    expect(resolve(`${TUNNEL}/__bz/enter?t=TKT`)).toEqual({
      mode: 'host',
      src: `${TUNNEL}/__bz/enter?t=TKT`,
      origin: TUNNEL,
    });
  });

  it('accepts the tab enter URL only in the tab context', () => {
    expect(resolve(`${TUNNEL}/__bz/enter?t=TKT&mode=tab`, { context: 'tab' })).toEqual({
      mode: 'host',
      src: `${TUNNEL}/__bz/enter?t=TKT&mode=tab`,
      origin: TUNNEL,
    });
    expect(resolve(`${TUNNEL}/__bz/enter?mode=tab&t=TKT`, { context: 'tab' })?.mode).toBe('host');
  });

  it('matches an uppercase tunnel id case-insensitively (hostnames are lowercased)', () => {
    expect(resolve(`${TUNNEL}/__bz/enter?t=T`, { tunnelId: ID.toUpperCase() })?.mode).toBe('host');
  });

  it.each([
    ['another tunnel id', `https://${OTHER_ID}.us.breezetunnel.test/__bz/enter?t=T`],
    ['the tunnel id not as the leftmost label', `https://x.${ID}.us.breezetunnel.test/__bz/enter?t=T`],
    ['a two-label host', `https://${ID}.test/__bz/enter?t=T`],
    ['the app origin itself', 'https://us.breeze-app.test/__bz/enter?t=T'],
    ['a subdomain of the app host', `https://${ID}.us.breeze-app.test/__bz/enter?t=T`],
    ['a tunnel suffix that is a parent of the app host', `https://${ID}.breeze-app.test/__bz/enter?t=T`],
    ['plain http on a public name', `http://${ID}.us.breezetunnel.test/__bz/enter?t=T`],
    ['userinfo', `https://u:p@${ID}.us.breezetunnel.test/__bz/enter?t=T`],
    ['a fragment', `${TUNNEL}/__bz/enter?t=T#x`],
    ['an empty fragment', `${TUNNEL}/__bz/enter?t=T#`],
    ['another path', `${TUNNEL}/?t=T`],
    ['a trailing slash on the path', `${TUNNEL}/__bz/enter/?t=T`],
    ['an empty ticket', `${TUNNEL}/__bz/enter?t=`],
    ['no ticket', `${TUNNEL}/__bz/enter`],
    ['a duplicated ticket', `${TUNNEL}/__bz/enter?t=A&t=B`],
    ['an extra param', `${TUNNEL}/__bz/enter?t=T&x=1`],
    ['mode=tab in the frame context', `${TUNNEL}/__bz/enter?t=T&mode=tab`],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<p>x</p>'],
    ['an unparseable string', 'https://'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
  ])('rejects %s', (_label, url) => {
    expect(resolve(url)).toBeNull();
  });

  it.each([
    ['no mode', `${TUNNEL}/__bz/enter?t=T`],
    ['a wrong mode value', `${TUNNEL}/__bz/enter?t=T&mode=frame`],
    ['an extra param', `${TUNNEL}/__bz/enter?t=T&mode=tab&x=1`],
  ])('rejects %s in the tab context', (_label, url) => {
    expect(resolve(url, { context: 'tab' })).toBeNull();
  });

  it('accepts http + port only for *.localhost (dev / e2e), with the app on app.localhost', () => {
    const dev = { appOrigin: 'http://app.localhost:18480', apiBase: 'http://app.localhost:18480' };
    expect(resolve(`http://${ID}.tunnel.localhost:18480/__bz/enter?t=T`, dev)).toEqual({
      mode: 'host',
      src: `http://${ID}.tunnel.localhost:18480/__bz/enter?t=T`,
      origin: `http://${ID}.tunnel.localhost:18480`,
    });
    // A tunnel host under the dev app host is still refused.
    expect(resolve(`http://${ID}.app.localhost:18480/__bz/enter?t=T`, dev)).toBeNull();
  });

  it('refuses a host-mode URL whose origin equals the API base even when it differs from the app origin', () => {
    expect(
      resolve(`https://${ID}.api.breeze.test/__bz/enter?t=T`, { apiBase: `https://${ID}.api.breeze.test` }),
    ).toBeNull();
  });
});

describe('resolveProxyTarget — path mode', () => {
  it('accepts the server path-mode URL for this tunnel and resolves it against the API base', () => {
    expect(resolve(`/api/v1/tunnel-http/${ID}/?__bzt=T`)).toEqual({
      mode: 'path',
      src: `https://us.breeze-app.test/api/v1/tunnel-http/${ID}/?__bzt=T`,
    });
    expect(resolve(`/api/v1/tunnel-http/${ID}/?__bzt=T`, { apiBase: 'https://api.breeze-app.test/' })).toEqual({
      mode: 'path',
      src: `https://api.breeze-app.test/api/v1/tunnel-http/${ID}/?__bzt=T`,
    });
  });

  it('accepts a percent-encoded ticket', () => {
    expect(resolve(`/api/v1/tunnel-http/${ID}/?__bzt=a%2Bb_c-d.e~f`)?.mode).toBe('path');
  });

  it.each([
    ['another tunnel', `/api/v1/tunnel-http/${OTHER_ID}/?__bzt=T`],
    ['a protocol-relative URL', '//evil.example/api'],
    ['an empty ticket', `/api/v1/tunnel-http/${ID}/?__bzt=`],
    ['an extra param', `/api/v1/tunnel-http/${ID}/?__bzt=T&x=1`],
    ['a fragment', `/api/v1/tunnel-http/${ID}/?__bzt=T#x`],
    ['whitespace', `/api/v1/tunnel-http/${ID}/?__bzt=T x`],
    ['a deeper path', `/api/v1/tunnel-http/${ID}/admin?__bzt=T`],
    ['an absolute path-mode URL', `https://us.breeze-app.test/api/v1/tunnel-http/${ID}/?__bzt=T`],
  ])('rejects %s', (_label, url) => {
    expect(resolve(url)).toBeNull();
  });
});

describe('sandbox tokens', () => {
  it('grants allow-same-origin only in host mode', () => {
    expect(HOST_MODE_SANDBOX).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
    );
    expect(PATH_MODE_SANDBOX).toBe('allow-scripts allow-forms allow-popups');
  });
});
