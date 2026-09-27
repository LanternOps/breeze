import '@/lib/i18n';

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNetworkAssetMutations } from './useNetworkAssetMutations';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const ok = (payload: unknown = { success: true }): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const fail = (payload: unknown, status = 500): Response =>
  ({ ok: false, status, statusText: 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ASSET = 'asset-1';

function mutations() {
  return renderHook(() => useNetworkAssetMutations()).result.current;
}

const lastCall = () => fetchMock.mock.calls.at(-1)!;
const lastInit = () => lastCall()[1] as RequestInit;
const lastBody = () => JSON.parse(lastInit().body as string);

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  fetchMock.mockResolvedValue(ok());
});

describe('useNetworkAssetMutations — request shapes', () => {
  it('patchIdentity PATCHes /discovery/assets/:id with only the supplied fields', async () => {
    await mutations().patchIdentity(ASSET, { label: 'Main Switch', notes: null, tags: ['core'] });

    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastBody()).toEqual({ label: 'Main Switch', notes: null, tags: ['core'] });
  });

  it('changeSite PATCHes siteId and folds the siteMove summary into the success toast', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      id: ASSET, siteId: 'site-b',
      siteMove: { unlinkedDevice: true, monitorsReattached: 3, topologyPoliciesDisabled: 1 },
    }));

    const result = await mutations().changeSite(ASSET, 'site-b', 'Branch');

    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastBody()).toEqual({ siteId: 'site-b' });
    expect(result.siteMove).toEqual({ unlinkedDevice: true, monitorsReattached: 3, topologyPoliciesDisabled: 1 });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'Moved to Branch. The link to its agent device was removed because that device is in a different site. 1 topology monitoring policy was disabled.',
    }));
  });

  it('changeSite keeps the toast short when the move undid nothing', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      id: ASSET, siteId: 'site-b',
      siteMove: { unlinkedDevice: false, monitorsReattached: 0, topologyPoliciesDisabled: 0 },
    }));

    await mutations().changeSite(ASSET, 'site-b', 'Branch');

    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Moved to Branch.' }));
  });

  it('patchIdentity carries resetTypeToAuto on its own', async () => {
    await mutations().patchIdentity(ASSET, { resetTypeToAuto: true });
    expect(lastBody()).toEqual({ resetTypeToAuto: true });
  });

  it('approve and dismiss PATCH their sub-resources with no body', async () => {
    const m = mutations();
    await m.approve(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/approve`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastInit().body).toBeUndefined();

    await m.dismiss(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/dismiss`);
    expect(lastInit().method).toBe('PATCH');
  });

  it('deleteAsset DELETEs /discovery/assets/:id', async () => {
    await mutations().deleteAsset(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}`);
    expect(lastInit().method).toBe('DELETE');
  });

  it('link POSTs the deviceId and unlink DELETEs the link sub-resource', async () => {
    const m = mutations();
    await m.link(ASSET, 'dev-9');
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/link`);
    expect(lastInit().method).toBe('POST');
    expect(lastBody()).toEqual({ deviceId: 'dev-9' });

    await m.unlink(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/link`);
    expect(lastInit().method).toBe('DELETE');
  });

  it('putSnmp PUTs the full config and returns the parsed body', async () => {
    fetchMock.mockResolvedValue(
      ok({ success: true, snmpDevice: { id: 'snmp-1', templateId: 't-1' }, templateSuggestion: null }),
    );
    const result = await mutations().putSnmp(ASSET, {
      snmpVersion: 'v2c', community: 'public', pollingInterval: 300, port: 161, templateId: 't-1',
    });

    expect(lastCall()[0]).toBe(`/monitoring/assets/${ASSET}/snmp`);
    expect(lastInit().method).toBe('PUT');
    expect(lastBody()).toEqual({
      snmpVersion: 'v2c', community: 'public', pollingInterval: 300, port: 161, templateId: 't-1',
    });
    expect(result.snmpDevice).toEqual({ id: 'snmp-1', templateId: 't-1' });
  });

  it('patchSnmp PATCHes only the supplied fields (pause/resume is isActive alone)', async () => {
    await mutations().patchSnmp(ASSET, { isActive: false });
    expect(lastCall()[0]).toBe(`/monitoring/assets/${ASSET}/snmp`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastBody()).toEqual({ isActive: false });
  });

  it('disableMonitoring PATCHes SNMP only and returns the checked response', async () => {
    fetchMock.mockResolvedValueOnce(ok({ snmpDevice: { id: 'snmp-1', templateId: null } }));
    const result = await mutations().disableMonitoring(ASSET);
    expect(lastCall()[0]).toBe(`/monitoring/assets/${ASSET}/snmp`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastBody()).toEqual({ isActive: false });
    expect(result).toEqual({ snmpDevice: { id: 'snmp-1', templateId: null } });
  });

  it('does not expose legacy check creation or deletion', () => {
    expect('createCheck' in mutations()).toBe(false);
    expect('deleteCheck' in mutations()).toBe(false);
  });

  it('does not report success when disabling SNMP fails in an HTTP-200 body', async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: false, error: 'Cannot pause SNMP' }));
    await expect(mutations().disableMonitoring(ASSET)).rejects.toBeInstanceOf(ActionError);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});

describe('useNetworkAssetMutations — outcome is never silent', () => {
  it('toasts a success message on every write', async () => {
    await mutations().approve(ASSET);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('toasts and throws an ActionError carrying the server status on failure', async () => {
    fetchMock.mockResolvedValue(fail({ error: 'Asset not found' }, 404));

    await expect(mutations().deleteAsset(ASSET)).rejects.toMatchObject({
      name: 'ActionError',
      status: 404,
      message: 'Asset not found',
    });
    expect(toastMock).toHaveBeenCalledWith({ message: 'Asset not found', type: 'error' });
  });

  it('surfaces a 409 as an ActionError with status 409 so sections can reload', async () => {
    fetchMock.mockResolvedValue(fail({ error: 'Asset changed' }, 409));

    const err = await mutations().patchIdentity(ASSET, { label: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(409);
  });
});
