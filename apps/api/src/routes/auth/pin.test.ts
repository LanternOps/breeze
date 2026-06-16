import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { pinRoutes } from './pin';

const {
  pinMocks,
  helperMocks,
  authState,
} = vi.hoisted(() => ({
  pinMocks: {
    setApproverPin: vi.fn(),
    verifyPinAttempt: vi.fn(),
  },
  helperMocks: {
    requireCurrentPasswordStepUp: vi.fn(),
    writeAuthAudit: vi.fn(),
  },
  authState: {
    requireAuthorizationHeader: true,
  },
}));

vi.mock('../../services/pin', () => ({
  ...pinMocks,
}));

vi.mock('./helpers', () => ({
  ...helperMocks,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (authState.requireAuthorizationHeader && !c.req.header('authorization')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      orgId: 'org-123',
      partnerId: 'partner-123',
      token: { mfa: true },
    });
    return next();
  }),
}));

describe('approver PIN routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.requireAuthorizationHeader = true;
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
    helperMocks.writeAuthAudit.mockReturnValue(undefined);
    pinMocks.setApproverPin.mockResolvedValue(undefined);
    pinMocks.verifyPinAttempt.mockResolvedValue({ verified: true, locked: false });
    app = new Hono();
    app.route('/', pinRoutes);
  });

  describe('PUT /auth/pin', () => {
    it('requires authentication', async () => {
      const res = await app.request('/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'pw', pin: '1234' }),
      });
      expect(res.status).toBe(401);
      expect(pinMocks.setApproverPin).not.toHaveBeenCalled();
    });

    it('requires the current-password step-up before setting a PIN', async () => {
      helperMocks.requireCurrentPasswordStepUp.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 }),
      );

      const res = await app.request('/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ currentPassword: 'wrong', pin: '1234' }),
      });

      expect(res.status).toBe(401);
      expect(pinMocks.setApproverPin).not.toHaveBeenCalled();
    });

    it('sets a valid numeric PIN and audits auth.pin.set', async () => {
      const res = await app.request('/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ currentPassword: 'correct', pin: '1234' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true });
      expect(helperMocks.requireCurrentPasswordStepUp).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        'correct',
        expect.any(String),
      );
      expect(pinMocks.setApproverPin).toHaveBeenCalledWith('user-123', '1234');
      expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'auth.pin.set', result: 'success' }),
      );
    });

    it('accepts a 6-digit PIN', async () => {
      const res = await app.request('/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ currentPassword: 'correct', pin: '123456' }),
      });

      expect(res.status).toBe(200);
      expect(pinMocks.setApproverPin).toHaveBeenCalledWith('user-123', '123456');
    });

    it('rejects a non-numeric PIN with 400 and never sets it', async () => {
      const res = await app.request('/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ currentPassword: 'correct', pin: 'abcd' }),
      });

      expect(res.status).toBe(400);
      expect(pinMocks.setApproverPin).not.toHaveBeenCalled();
    });

    it('rejects a too-short PIN with 400', async () => {
      const res = await app.request('/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ currentPassword: 'correct', pin: '12' }),
      });

      expect(res.status).toBe(400);
      expect(pinMocks.setApproverPin).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/pin/verify', () => {
    it('requires authentication', async () => {
      const res = await app.request('/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
      });
      expect(res.status).toBe(401);
      expect(pinMocks.verifyPinAttempt).not.toHaveBeenCalled();
    });

    it('verifies a PIN and returns { verified, locked }', async () => {
      pinMocks.verifyPinAttempt.mockResolvedValueOnce({ verified: true, locked: false });

      const res = await app.request('/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ pin: '1234' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ verified: true, locked: false });
      expect(pinMocks.verifyPinAttempt).toHaveBeenCalledWith('user-123', '1234');
    });

    it('returns { verified:false, locked:true } when the PIN is locked', async () => {
      pinMocks.verifyPinAttempt.mockResolvedValueOnce({ verified: false, locked: true });

      const res = await app.request('/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ pin: '9999' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ verified: false, locked: true });
    });

    it('rejects a non-numeric PIN with 400 and never calls verify', async () => {
      const res = await app.request('/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ pin: 'abcd' }),
      });

      expect(res.status).toBe(400);
      expect(pinMocks.verifyPinAttempt).not.toHaveBeenCalled();
    });
  });
});
