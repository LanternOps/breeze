import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseMessagingError } from 'firebase-admin/messaging';

const { messagingSend, initializeApp, getApp, cert, appsList } = vi.hoisted(() => ({
  messagingSend: vi.fn(),
  initializeApp: vi.fn(() => ({})),
  getApp: vi.fn(() => ({})),
  cert: vi.fn((sa: unknown) => sa),
  appsList: [] as unknown[],
}));

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => appsList),
  getApp,
  initializeApp,
  cert,
}));

vi.mock('firebase-admin/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase-admin/messaging')>();
  return {
    ...actual,
    getMessaging: vi.fn(() => ({ send: messagingSend })),
  };
});

import {
  isFcmConfigured,
  sendFcmNotification,
  __resetFcmAppForTests,
} from './fcm';

const ORIGINAL_ENV = process.env.FIREBASE_SERVICE_ACCOUNT;

beforeEach(() => {
  __resetFcmAppForTests();
  messagingSend.mockReset();
  initializeApp.mockClear();
  appsList.length = 0;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
  else process.env.FIREBASE_SERVICE_ACCOUNT = ORIGINAL_ENV;
});

describe('isFcmConfigured', () => {
  it('is false when FIREBASE_SERVICE_ACCOUNT is unset', () => {
    expect(isFcmConfigured()).toBe(false);
  });

  it('is true once FIREBASE_SERVICE_ACCOUNT is set', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    expect(isFcmConfigured()).toBe(true);
  });
});

describe('sendFcmNotification', () => {
  it('returns not_configured without touching firebase-admin when unset', async () => {
    const res = await sendFcmNotification('tok', { title: 't', body: 'b' });
    expect(res).toEqual({ ok: false, reason: 'not_configured' });
    expect(messagingSend).not.toHaveBeenCalled();
  });

  it('sends with android-specific fields and stringified data on success', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    messagingSend.mockResolvedValueOnce('projects/p/messages/123');

    const res = await sendFcmNotification('tok', {
      title: 'Approval requested',
      body: 'Claude Desktop: Delete devices',
      data: { type: 'approval', approvalId: 'ap-1' },
      ttl: 60,
      channelId: 'approvals',
      collapseId: 'approval:ap-1',
    });

    expect(res).toEqual({ ok: true, messageId: 'projects/p/messages/123' });
    expect(messagingSend).toHaveBeenCalledWith({
      token: 'tok',
      notification: { title: 'Approval requested', body: 'Claude Desktop: Delete devices' },
      data: { type: 'approval', approvalId: 'ap-1' },
      android: {
        priority: 'high',
        ttl: 60_000,
        collapseKey: 'approval:ap-1',
        notification: { channelId: 'approvals' },
      },
    });
  });

  it('reports unregistered:true for a dead token without throwing', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    messagingSend.mockRejectedValueOnce({ code: 'messaging/registration-token-not-registered' });

    const res = await sendFcmNotification('dead-tok', { title: 't', body: 'b' });

    expect(res).toEqual({
      ok: false,
      reason: 'messaging/registration-token-not-registered',
      unregistered: true,
    });
  });

  it('reports unregistered:true for a real v14-shaped FirebaseMessagingError (registration-token-not-registered)', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    // Construct via the SDK's own error class (not a plain {code} object) so a
    // firebase-admin major bump that reshapes error internals fails this test
    // first, before it silently breaks sendFcmNotification's code matching.
    // The public .d.ts hides the constructor (marked @internal), so we go
    // through the runtime shape directly — this is what admin.messaging().send()
    // actually throws.
    const Ctor = FirebaseMessagingError as unknown as new (info: {
      code: string;
      message: string;
    }) => FirebaseMessagingError;
    const err = new Ctor({
      code: 'registration-token-not-registered',
      message: 'Requested entity was not found.',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('messaging/registration-token-not-registered');
    messagingSend.mockRejectedValueOnce(err);

    const res = await sendFcmNotification('dead-tok', { title: 't', body: 'b' });

    expect(res).toEqual({
      ok: false,
      reason: 'messaging/registration-token-not-registered',
      unregistered: true,
    });
  });

  it('reports a live failure without unregistered on any other error', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    messagingSend.mockRejectedValueOnce({ code: 'messaging/internal-error' });

    const res = await sendFcmNotification('tok', { title: 't', body: 'b' });

    expect(res).toEqual({ ok: false, reason: 'messaging/internal-error' });
  });
});
