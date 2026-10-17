import { beforeEach, describe, expect, it, vi } from 'vitest';

const supports = vi.hoisted(() => vi.fn());
vi.mock('@breeze/shared', async () => {
  const actual = await vi.importActual<typeof import('@breeze/shared')>('@breeze/shared');
  return { ...actual, agentSupportsEndpointMessaging: supports };
});

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../stores/auth';
import {
  deviceMessagingCapability,
  endpointMessageIssueKey,
  getEndpointMessage,
  listEndpointMessages,
  resendEndpointMessage,
  retractEndpointMessage,
} from './endpointMessages';

const authMock = vi.mocked(fetchWithAuth);
const res = (status: number, payload: unknown) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

describe('history API client', () => {
  beforeEach(() => authMock.mockReset());

  it('lists with limit and cursor', async () => {
    authMock.mockResolvedValue(res(200, { items: [], nextCursor: null }));
    await expect(listEndpointMessages({ limit: 50, cursor: 'abc' })).resolves.toEqual({ items: [], nextCursor: null });
    expect(authMock.mock.calls[0]![0]).toBe('/endpoint-messages?limit=50&cursor=abc');
  });

  it('loads one message and returns null on 404', async () => {
    authMock.mockResolvedValue(res(404, { error: 'not_found' }));
    await expect(getEndpointMessage('m1')).resolves.toBeNull();
    expect(authMock.mock.calls[0]![0]).toBe('/endpoint-messages/m1');
  });

  it('retract POSTs with no body; resend POSTs the new messageId', async () => {
    authMock.mockResolvedValue(res(200, { ok: true }));
    await retractEndpointMessage('m1', { errorFallback: 'x' });
    expect(authMock.mock.calls[0]![0]).toBe('/endpoint-messages/m1/retract');
    expect((authMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    await resendEndpointMessage('m1', 'new-id', { errorFallback: 'x' });
    expect(authMock.mock.calls[1]![0]).toBe('/endpoint-messages/m1/resend');
    expect(JSON.parse(String((authMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ messageId: 'new-id' });
  });
});

describe('deviceMessagingCapability', () => {
  beforeEach(() => supports.mockReset());

  it('is unsupported when the shared gate rejects the agent version', () => {
    supports.mockReturnValue(false);
    expect(deviceMessagingCapability({ osType: 'windows', agentVersion: '0.100.0' })).toBe('unsupported');
    expect(supports).toHaveBeenCalledWith('0.100.0');
  });

  it('is unsupported for a missing agent version', () => {
    supports.mockReturnValue(false);
    expect(deviceMessagingCapability({ osType: 'macos', agentVersion: null })).toBe('unsupported');
  });

  it('maps windows to assist_card and macOS/Linux to native when supported', () => {
    supports.mockReturnValue(true);
    expect(deviceMessagingCapability({ osType: 'windows', agentVersion: '9.0.0' })).toBe('assist_card');
    expect(deviceMessagingCapability({ osType: 'macos', agentVersion: '9.0.0' })).toBe('native');
    expect(deviceMessagingCapability({ osType: 'linux', agentVersion: '9.0.0' })).toBe('native');
  });
});

describe('endpointMessageIssueKey', () => {
  it.each([
    ['body: html is not allowed', 'html'],
    ['body: images are not allowed', 'images'],
    ['body: links must use https', 'httpsLinks'],
    ['body: reference links are not allowed', 'referenceLinks'],
    ['title: html is not allowed', 'titleHtml'],
    ['title: links are not allowed', 'titleLinks'],
    ['something new from a future validator', 'invalid'],
  ])('maps %s to %s', (issue, key) => {
    expect(endpointMessageIssueKey(issue)).toBe(key);
  });
});
