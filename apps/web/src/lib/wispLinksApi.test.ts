/**
 * W08 (#9921): the links and partner-switch calls are grant/partner-addressed —
 * never the org switcher's org — and mutate through runAction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));
vi.mock('../stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('../components/shared/Toast', () => ({ showToast: h.showToast }));

import { addWispLink, listWispLinks, removeWispLink, pinWispLink, listWispNeighbours } from './wispLinksApi';
import { getWispPartnerEnabled, setWispPartnerEnabled } from './wispPartnerSettingsApi';
import { ActionError } from './runAction';

const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const link = { id: 'l-1', ref: { kind: 'ticket', id: 't-1', orgId: 'o-1' }, label: '#1', status: 'open', href: '/tickets/t-1', source: 'user_pin', lastTouchedAt: '2026-10-24T08:00:00Z', createdAt: '' };

describe('wispLinksApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists a thread’s links without the ambient org, and throws on a body without links', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: { links: [link] } }));
    expect(await listWispLinks('th/1')).toEqual([link]);
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/th%2F1/links', { skipOrgIdInjection: true });
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: {} }));
    await expect(listWispLinks('th-1')).rejects.toThrow(/no links array/);
    h.fetchWithAuth.mockResolvedValueOnce(res(404, {}));
    await expect(listWispLinks('th-1')).rejects.toThrow();
  });

  it('adds with kind/id and the orgId hint only when present; success is toasted', async () => {
    h.fetchWithAuth.mockResolvedValue(res(201, { data: { link } }));
    expect(await addWispLink('th-1', { kind: 'ticket', id: 't-1', orgId: 'o-1' })).toEqual(link);
    const [url, init] = h.fetchWithAuth.mock.calls[0];
    expect(url).toBe('/wisp/thread/th-1/links');
    expect(init).toMatchObject({ method: 'POST', skipOrgIdInjection: true });
    expect(JSON.parse(init.body)).toEqual({ kind: 'ticket', id: 't-1', orgId: 'o-1' });
    await addWispLink('th-1', { kind: 'user', id: 'u-1', orgId: null });
    expect(JSON.parse(h.fetchWithAuth.mock.calls[1][1].body)).toEqual({ kind: 'user', id: 'u-1' });
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('a refusal is an ActionError carrying the server code, toasted once', async () => {
    h.fetchWithAuth.mockResolvedValue(res(403, { error: 'That item is outside what you have delegated to Wisp.', code: 'outside_ceiling' }));
    await expect(addWispLink('th-1', { kind: 'ticket', id: 't-1' })).rejects.toMatchObject({ status: 403, code: 'outside_ceiling' });
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('removes by link id without the ambient org (204)', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response);
    await removeWispLink('th-1', 'l-1');
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/th-1/links/l-1', { method: 'DELETE', skipOrgIdInjection: true });
  });
});

describe('wispPartnerSettingsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads and writes the partner switch without the ambient org', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: { enabled: true } }));
    expect(await getWispPartnerEnabled()).toBe(true);
    expect(h.fetchWithAuth).toHaveBeenLastCalledWith('/wisp/partner-settings', { skipOrgIdInjection: true });
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: { enabled: false } }));
    expect(await setWispPartnerEnabled(false)).toBe(false);
    const [, init] = h.fetchWithAuth.mock.calls[1];
    expect(init).toMatchObject({ method: 'PUT', skipOrgIdInjection: true });
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('a write answered without the stored value throws instead of claiming the requested one', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: {} }));
    await expect(setWispPartnerEnabled(true)).rejects.toThrow(/malformed/);
  });

  it('a non-admin write is the server’s 403 as an ActionError', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(403, { error: 'Only partner admins', code: 'partner_admin_required' }));
    await expect(setWispPartnerEnabled(false)).rejects.toBeInstanceOf(ActionError);
  });
});

it('pins through runAction without ambient org and encodes both ids', async () => {
  h.fetchWithAuth.mockResolvedValue(res(200, { data: { link } }));
  expect(await pinWispLink('th/1', 'l/1')).toEqual(link);
  expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/th%2F1/links/l%2F1/pin', { method: 'POST', skipOrgIdInjection: true });
  h.fetchWithAuth.mockResolvedValue(res(409, { error: 'Pin limit', code: 'link_limit' }));
  await expect(pinWispLink('th1', 'l1')).rejects.toMatchObject({ status: 409, code: 'link_limit' });
});


it('keeps neighbours unused until W02 (W04-D1), without making a request', async () => {
  h.fetchWithAuth.mockClear();
  await expect(listWispNeighbours('th1', { kind: 'ticket', id: 't1' })).rejects.toThrow('Wisp neighbours are not wired yet');
  expect(h.fetchWithAuth).not.toHaveBeenCalled();
});
