import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureValues = new Map<string, string>();
const fetchWithTimeout = vi.fn();

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { secureValues.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { secureValues.delete(key); }),
}));
vi.mock('@sentry/react-native', () => ({ captureMessage: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn(async () => 'https://api.example.test') }));
vi.mock('./installationId', () => ({
  getOrCreateInstallationId: vi.fn(async () => 'install-1'),
}));
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));
vi.mock('./csrfToken', () => ({
  applyCsrfSignal: vi.fn(async () => undefined),
  forgetCsrfToken: vi.fn(async () => undefined),
  getCsrfHeaderValue: vi.fn(async () => 'csrf'),
  readCsrfCookie: vi.fn(() => ({ kind: 'absent' })),
}));

import { AUTH_TOKEN_KEY } from './authSessionKeys';
import {
  coreRequest,
  DEVICE_BLOCKED_CODE,
  getAuthImageHeaders,
  MOBILE_DEVICE_ID_HEADER,
  onDeviceBlocked,
} from './api';

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function requestInit(callIndex = 0): RequestInit {
  return fetchWithTimeout.mock.calls[callIndex]![1] as RequestInit;
}

function requestHeaders(callIndex = 0): Record<string, string> {
  return requestInit(callIndex).headers as Record<string, string>;
}

/** Case-insensitive header lookup — a stray `content-type` is just as fatal. */
function headerNames(callIndex = 0): string[] {
  return Object.keys(requestHeaders(callIndex)).map((k) => k.toLowerCase());
}

function multipart(): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'shot.jpg');
  return form;
}

beforeEach(() => {
  secureValues.clear();
  secureValues.set(AUTH_TOKEN_KEY, 'token-1');
  fetchWithTimeout.mockReset();
});

describe('coreRequest with a FormData body', () => {
  it('omits Content-Type so the runtime can supply its own multipart boundary', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(201, { data: { id: 'att-1' } }));

    await coreRequest('/tickets/t-1/attachments', { method: 'POST', body: multipart() });

    expect(headerNames()).not.toContain('content-type');
  });

  it('still sends auth, CSRF and the mobile device id on a multipart request', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(201, { data: { id: 'att-1' } }));

    await coreRequest('/tickets/t-1/attachments', { method: 'POST', body: multipart() });

    expect(requestHeaders()).toMatchObject({
      Authorization: 'Bearer token-1',
      'x-breeze-csrf': 'csrf',
      [MOBILE_DEVICE_ID_HEADER]: 'install-1',
    });
  });

  it('passes the FormData body through untouched', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(201, { data: { id: 'att-1' } }));
    const form = multipart();

    await coreRequest('/tickets/t-1/attachments', { method: 'POST', body: form });

    expect(requestInit().body).toBe(form);
  });

  it('strips a caller-supplied Content-Type, which would break the boundary', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(201, { data: { id: 'att-1' } }));

    await coreRequest('/tickets/t-1/attachments', {
      method: 'POST',
      body: multipart(),
      headers: { 'Content-Type': 'multipart/form-data' },
    });

    expect(headerNames()).not.toContain('content-type');
  });

  it('honours an explicit long timeout for a slow upload', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(201, { data: { id: 'att-1' } }));

    await coreRequest('/tickets/t-1/attachments', { method: 'POST', body: multipart() }, 120_000);

    expect(fetchWithTimeout.mock.calls[0]![2]).toBe(120_000);
  });

  it('handles device_blocked identically to a JSON request', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      response(403, { code: DEVICE_BLOCKED_CODE, reason: 'lost', error: 'blocked' })
    );
    const seen: (string | null)[] = [];
    const unsubscribe = onDeviceBlocked((reason) => seen.push(reason));

    await expect(
      coreRequest('/tickets/t-1/attachments', { method: 'POST', body: multipart() })
    ).rejects.toMatchObject({ code: DEVICE_BLOCKED_CODE, statusCode: 403 });
    unsubscribe();

    expect(seen).toEqual(['lost']);
  });
});

describe('coreRequest with a JSON body', () => {
  it('still sets Content-Type: application/json', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(200, { data: {} }));

    await coreRequest('/tickets/t-1/comments', {
      method: 'POST',
      body: JSON.stringify({ content: 'hi' }),
    });

    expect(requestHeaders()).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('still sets Content-Type on a GET with no body', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(200, { data: {} }));

    await coreRequest('/tickets/t-1');

    expect(requestHeaders()).toMatchObject({ 'Content-Type': 'application/json' });
  });
});

describe('getAuthImageHeaders', () => {
  it('returns the bearer token and device id for <Image source={{ headers }}>', async () => {
    await expect(getAuthImageHeaders()).resolves.toEqual({
      Authorization: 'Bearer token-1',
      [MOBILE_DEVICE_ID_HEADER]: 'install-1',
    });
  });

  it('omits Authorization when no token is stored rather than sending "Bearer null"', async () => {
    secureValues.delete(AUTH_TOKEN_KEY);

    await expect(getAuthImageHeaders()).resolves.toEqual({
      [MOBILE_DEVICE_ID_HEADER]: 'install-1',
    });
  });
});
