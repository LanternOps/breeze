// apps/api/src/config/tunnelOrigin.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildPathModeTicketUrl,
  buildTunnelEnterUrl,
  buildTunnelOrigin,
  isTunnelDomainHost,
  matchTunnelHost,
  parseTunnelOriginConfig,
  type TunnelOriginEnv,
} from './tunnelOrigin';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TEMPLATE = 'https://{id}.us.breezetunnel.test';
const PROD: TunnelOriginEnv = {
  NODE_ENV: 'production',
  PUBLIC_APP_URL: 'https://us.breeze-app.test',
  PUBLIC_API_URL: 'https://us.breeze-app.test',
  CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test',
};

function config(env: TunnelOriginEnv) {
  const parsed = parseTunnelOriginConfig(env);
  if (!parsed.ok) throw new Error(parsed.issues.map((i) => i.message).join('\n'));
  return parsed.config;
}
function issueText(env: TunnelOriginEnv): string {
  const parsed = parseTunnelOriginConfig(env);
  return parsed.ok ? '' : parsed.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
}

describe('parseTunnelOriginConfig', () => {
  it('is off when the template is unset or blank', () => {
    expect(config(PROD)).toBeNull();
    expect(config({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: '   ' })).toBeNull();
  });

  it('parses the template and defaults the frame ancestor to the PUBLIC_APP_URL origin', () => {
    expect(config({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE })).toEqual({
      scheme: 'https', suffix: 'us.breezetunnel.test', port: '', frameAncestor: 'https://us.breeze-app.test',
    });
  });

  it.each([
    ['plain http in production', 'http://{id}.us.breezetunnel.test'],
    ['userinfo', 'https://u@{id}.us.breezetunnel.test'],
    ['a path', 'https://{id}.us.breezetunnel.test/x'],
    ['a query', 'https://{id}.us.breezetunnel.test?x=1'],
    ['a fragment', 'https://{id}.us.breezetunnel.test#x'],
    ['a port in production', 'https://{id}.us.breezetunnel.test:8443'],
    ['{id} not the whole leftmost label', 'https://tun-{id}.us.breezetunnel.test'],
    ['two {id}s', 'https://{id}.{id}.breezetunnel.test'],
    ['no {id}', 'https://x.us.breezetunnel.test'],
    ['a single-label suffix', 'https://{id}.test'],
    ['uppercase', 'https://{id}.US.breezetunnel.test'],
    ['an invalid label', 'https://{id}.-us.breezetunnel.test'],
    ['a trailing slash', 'https://{id}.us.breezetunnel.test/'],
  ])('rejects %s', (_label, template) => {
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: template })).toMatch(/TUNNEL_ORIGIN_TEMPLATE/);
  });

  it('rejects a suffix that shares the app registrable domain', () => {
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.tunnel.breeze-app.test' }))
      .toMatch(/registrable domain/);
  });

  it('rejects a suffix that shares a CORS origin registrable domain', () => {
    expect(issueText({
      ...PROD, CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test,https://portal.other-brand.test',
      TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.t.other-brand.test',
    })).toMatch(/registrable domain/);
  });

  it('rejects when a private PSL suffix would mask a shared public parent', () => {
    expect(issueText({
      ...PROD, PUBLIC_APP_URL: 'https://acme.github.io', PUBLIC_API_URL: 'https://acme.github.io',
      CORS_ALLOWED_ORIGINS: 'https://acme.github.io', TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.tunnels.github.io',
    })).toMatch(/registrable domain/);
  });

  it('compares a wildcard CORS entry by its parent domain', () => {
    expect(issueText({ ...PROD, CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test,https://*.example.com', TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.t.example.com' }))
      .toMatch(/registrable domain/);
    expect(issueText({ ...PROD, CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test,https://*.other-brand.test', TUNNEL_ORIGIN_TEMPLATE: TEMPLATE }))
      .toBe('');
  });

  it('fails closed on an unparseable origin entry', () => {
    expect(issueText({ ...PROD, CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test,not a url', TUNNEL_ORIGIN_TEMPLATE: TEMPLATE }))
      .toMatch(/TUNNEL_ORIGIN_TEMPLATE: cannot verify .*not a url/);
  });

  it('fails closed on an origin host with no registrable domain', () => {
    expect(issueText({ ...PROD, CORS_ALLOWED_ORIGINS: 'https://intranet', TUNNEL_ORIGIN_TEMPLATE: TEMPLATE }))
      .toMatch(/no registrable domain/);
  });

  it('treats IP-literal origins as separate from any DNS suffix', () => {
    expect(config({
      ...PROD, CORS_ALLOWED_ORIGINS: 'http://192.168.1.10:4321', PUBLIC_API_URL: 'http://[::1]:3001',
      TUNNEL_ORIGIN_TEMPLATE: TEMPLATE,
    })).toEqual({ scheme: 'https', suffix: 'us.breezetunnel.test', port: '', frameAncestor: 'https://us.breeze-app.test' });
  });

  it.each(['PUBLIC_PORTAL_URL', 'PUBLIC_WEB_URL', 'PUBLIC_URL', 'API_URL', 'WEBAUTHN_ORIGIN'] as const)(
    'rejects a %s on the tunnel registrable domain', (key) => {
      expect(issueText({ ...PROD, [key]: 'https://portal.breezetunnel.test', TUNNEL_ORIGIN_TEMPLATE: TEMPLATE }))
        .toMatch(new RegExp(`${key}.*registrable domain`));
    });

  it('requires TUNNEL_FRAME_ANCESTOR to be an exact https origin', () => {
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE, TUNNEL_FRAME_ANCESTOR: 'https://us.breeze-app.test/' }))
      .toMatch(/TUNNEL_FRAME_ANCESTOR/);
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE, TUNNEL_FRAME_ANCESTOR: 'http://us.breeze-app.test' }))
      .toMatch(/TUNNEL_FRAME_ANCESTOR/);
  });

  it('fails closed when no frame ancestor can be derived', () => {
    expect(issueText({ NODE_ENV: 'production', TUNNEL_ORIGIN_TEMPLATE: TEMPLATE }))
      .toMatch(/TUNNEL_FRAME_ANCESTOR/);
  });

  it('allows http and a port only for *.localhost outside production', () => {
    const dev: TunnelOriginEnv = {
      NODE_ENV: 'development', PUBLIC_APP_URL: 'http://localhost:18480',
      TUNNEL_ORIGIN_TEMPLATE: 'http://{id}.tunnel.localhost:18480', TUNNEL_FRAME_ANCESTOR: 'http://localhost:18480',
    };
    expect(config(dev)).toEqual({ scheme: 'http', suffix: 'tunnel.localhost', port: '18480', frameAncestor: 'http://localhost:18480' });
    expect(issueText({ ...dev, NODE_ENV: 'production' })).toMatch(/TUNNEL_ORIGIN_TEMPLATE/);
  });
});

describe('tunnel URL builders and Host matching', () => {
  const cfg = config({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE })!;

  it('builds the origin, enter URL and path-mode URL', () => {
    expect(buildTunnelOrigin(cfg, ID)).toBe(`https://${ID}.us.breezetunnel.test`);
    expect(buildTunnelEnterUrl(cfg, ID, 'a b/c')).toBe(`https://${ID}.us.breezetunnel.test/__bz/enter?t=a+b%2Fc`);
    expect(buildTunnelEnterUrl(cfg, ID, 'T', 'tab')).toBe(`https://${ID}.us.breezetunnel.test/__bz/enter?t=T&mode=tab`);
    expect(buildPathModeTicketUrl(ID, 'a/b')).toBe(`/api/v1/tunnel-http/${ID}/?__bzt=a%2Fb`);
  });

  it.each([
    [`${ID}.us.breezetunnel.test`, ID],
    [`${ID.toUpperCase()}.US.BREEZETUNNEL.TEST`, ID],
    [`${ID}.us.breezetunnel.test.`, ID],
    [`${ID}.us.breezetunnel.test:443`, ID],
    [`${ID}.us.breezetunnel.test:8443`, null],
    [`not-a-uuid.us.breezetunnel.test`, null],
    [`a.${ID}.us.breezetunnel.test`, null],
    ['us.breezetunnel.test', null],
    ['us.breeze-app.test', null],
    [undefined, null],
  ])('matchTunnelHost(%s) → %s', (host, expected) => {
    expect(matchTunnelHost(host, cfg)).toBe(expected);
  });

  it.each([
    [`${ID}.us.breezetunnel.test`, true],
    ['a.b.us.breezetunnel.test', true],
    ['us.breezetunnel.test', true],
    ['US.BREEZETUNNEL.TEST.', true],
    [`${ID}.us.breezetunnel.test.`, true],
    [`a.${ID}.us.breezetunnel.test`, true],
    [`a.${ID}.us.breezetunnel.test.:443`, true],
    [`${ID}.us.breezetunnel.test:8443`, true],
    ['evil-us.breezetunnel.test', false],
    ['us.breeze-app.test', false],
    [undefined, false],
  ])('isTunnelDomainHost(%s) → %s', (host, expected) => {
    expect(isTunnelDomainHost(host, cfg)).toBe(expected);
  });
});
