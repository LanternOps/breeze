import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same harness as api.mfa.test.ts: SecureStore, Sentry, server URL,
// installation id, fetch and CSRF are stubbed so `changePassword` runs
// end-to-end through the real `requestWithPrefix`/`coreRequest` machinery
// against a scripted response, instead of mocking './api' away.
const fetchWithTimeout = vi.fn();

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
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

import { ApiError, changePassword } from './api';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe('changePassword', () => {
  // Root cause of #4747: `services/api.ts` used to throw a plain object
  // literal cast `as ApiError`, so `err instanceof Error` at the
  // ChangePasswordSheet catch site (screens/chat/components/
  // ChangePasswordSheet.tsx:176 — `err instanceof Error ? err.message :
  // 'Could not change password.'`) was always false and the server's message
  // ("current password is incorrect", rate-limited, etc.) never reached the
  // user. This test exercises the exact same expression against what
  // `changePassword` actually throws, since the mobile app has no React
  // Native test runtime configured (see vitest.config.ts) to render the
  // sheet itself.
  it('rejects with a message the ChangePasswordSheet catch handler surfaces verbatim on a 400', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      response(400, { error: 'Current password is incorrect' }),
    );

    let caught: unknown;
    try {
      await changePassword('wrong-current', 'new-password-123');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // The exact ternary from ChangePasswordSheet.tsx's catch block.
    const msg = caught instanceof Error ? caught.message : 'Could not change password.';
    expect(msg).toBe('Current password is incorrect');
  });

  it('rejects with an ApiError that is instanceof both ApiError and Error, carrying status/code', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      response(429, { error: 'Too many attempts', code: 'rate_limited' }),
    );

    // One caught value, asserted three ways — a separate `mockResolvedValueOnce`
    // per `expect(...).rejects` call would starve the queue after the first
    // await (vitest's mock queue is consumed per call), leaving later calls to
    // resolve `undefined` and fail somewhere unrelated (`response.headers` on
    // `undefined`) rather than re-exercising this path.
    let caught: unknown;
    try {
      await changePassword('a', 'b');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      message: 'Too many attempts',
      code: 'rate_limited',
      statusCode: 429,
    });
  });
});

describe('ApiError', () => {
  it('is a real Error subclass — instanceof Error and instanceof ApiError both hold', () => {
    const err = new ApiError({ message: 'boom', code: 'x', statusCode: 500 });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('boom');
    expect(err.code).toBe('x');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('ApiError');
  });
});
