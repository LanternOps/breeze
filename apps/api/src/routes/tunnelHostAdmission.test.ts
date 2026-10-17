import { describe, expect, it } from 'vitest';
import { admitTunnelHostRequest, type TunnelAdmissionInput } from './tunnelHostAdmission';

const T = 'https://eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test';
const SIBLING = 'https://ffffffff-ffff-4fff-8fff-ffffffffffff.us.breezetunnel.test';
const APP = 'https://us.breeze-app.test';
const base: TunnelAdmissionInput = { method: 'GET', path: '/', tunnelOrigin: T };
const admit = (over: Partial<TunnelAdmissionInput>) => admitTunnelHostRequest({ ...base, ...over });

describe('admitTunnelHostRequest (spec §4a)', () => {
  it.each(['same-origin', 'none', 'Same-Origin'])('admits Sec-Fetch-Site %s', (site) => {
    expect(admit({ secFetchSite: site })).toEqual({ ok: true });
  });

  it.each(['same-site', 'cross-site', 'bogus', ''])('refuses Sec-Fetch-Site %j — GET included', (site) => {
    expect(admit({ secFetchSite: site })).toMatchObject({ ok: false, status: 403, reason: 'cross_site' });
    expect(admit({ secFetchSite: site, method: 'POST', origin: T })).toMatchObject({ ok: false, status: 403, reason: 'cross_site' });
  });

  it('admits the app’s cross-site iframe/top-level navigation to /__bz/enter only', () => {
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'iframe' })).toEqual({ ok: true });
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'document' })).toEqual({ ok: true });
    // Older browsers send no Sec-Fetch-* at all; the one-time ticket is the guard.
    expect(admit({ path: '/__bz/enter' })).toEqual({ ok: true });
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'image' })).toMatchObject({ ok: false, status: 403, reason: 'enter_not_navigation' });
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'empty' })).toMatchObject({ ok: false, reason: 'enter_not_navigation' });
    expect(admit({ path: '/__bz/enter', method: 'POST', secFetchSite: 'cross-site' })).toMatchObject({ ok: false, reason: 'enter_not_navigation' });
    expect(admit({ path: '/__bz/enter', method: 'HEAD', secFetchSite: 'cross-site', secFetchDest: 'iframe' })).toMatchObject({ ok: false, reason: 'enter_not_navigation' });
    expect(admit({ path: '/__bz/ping', secFetchSite: 'cross-site' })).toMatchObject({ ok: false, reason: 'cross_site' });
    // The exemption is the exact raw path; an encoded or cased variant is not the entry point.
    expect(admit({ path: '/%5F%5Fbz/enter', secFetchSite: 'cross-site', secFetchDest: 'iframe' })).toMatchObject({ ok: false, reason: 'cross_site' });
    expect(admit({ path: '/__BZ/enter', secFetchSite: 'cross-site', secFetchDest: 'iframe' })).toMatchObject({ ok: false, reason: 'cross_site' });
  });

  describe('Sec-Fetch-Site absent (older browsers)', () => {
    it('requires a matching Origin on unsafe methods', () => {
      expect(admit({ method: 'POST', origin: T })).toEqual({ ok: true });
      expect(admit({ method: 'POST' })).toMatchObject({ ok: false, status: 403, reason: 'missing_origin' });
      expect(admit({ method: 'put' })).toMatchObject({ ok: false, reason: 'missing_origin' });
      expect(admit({ method: 'OPTIONS' })).toMatchObject({ ok: false, reason: 'missing_origin' });
      expect(admit({ method: 'DELETE', origin: 'null' })).toMatchObject({ ok: false, reason: 'foreign_origin' });
      expect(admit({ method: 'POST', origin: SIBLING })).toMatchObject({ ok: false, reason: 'foreign_origin' });
      expect(admit({ method: 'POST', origin: APP })).toMatchObject({ ok: false, reason: 'foreign_origin' });
    });

    it('admits a plain GET/HEAD but refuses a GET carrying a foreign or opaque Origin', () => {
      expect(admit({})).toEqual({ ok: true });
      expect(admit({ method: 'HEAD' })).toEqual({ ok: true });
      expect(admit({ origin: SIBLING })).toMatchObject({ ok: false, reason: 'foreign_origin' });
      expect(admit({ origin: 'null' })).toMatchObject({ ok: false, reason: 'foreign_origin' });
    });
  });

  it('refuses a foreign Origin even when Sec-Fetch-Site claims same-origin', () => {
    expect(admit({ secFetchSite: 'same-origin', method: 'POST', origin: SIBLING })).toMatchObject({ ok: false, reason: 'foreign_origin' });
    expect(admit({ secFetchSite: 'same-origin', origin: APP })).toMatchObject({ ok: false, reason: 'foreign_origin' });
  });

  it('404s service-worker script fetches before anything else', () => {
    expect(admit({ serviceWorker: 'script', secFetchSite: 'same-origin' })).toEqual({ ok: false, status: 404, reason: 'service_worker' });
    expect(admit({ serviceWorker: ' Script ', secFetchSite: 'cross-site' })).toEqual({ ok: false, status: 404, reason: 'service_worker' });
    expect(admit({ secFetchDest: 'serviceworker', secFetchSite: 'same-origin' })).toEqual({ ok: false, status: 404, reason: 'service_worker' });
    expect(admit({ path: '/__bz/enter', secFetchDest: 'serviceworker', secFetchSite: 'cross-site' })).toEqual({ ok: false, status: 404, reason: 'service_worker' });
  });
});
