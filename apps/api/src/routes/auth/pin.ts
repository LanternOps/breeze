import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { approverPinSchema } from '@breeze/shared';
import { authMiddleware } from '../../middleware/auth';
import { setApproverPin, verifyPinAttempt } from '../../services/pin';
import { requireCurrentPasswordStepUp, writeAuthAudit } from './helpers';

// Setting the approval PIN is a security-sensitive action, so it reconfirms the
// current password (mirrors routes/auth/passkeys.ts + routes/authenticator.ts).
const setPinSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  pin: approverPinSchema,
});

const verifyPinSchema = z.object({
  pin: approverPinSchema,
});

export const pinRoutes = new Hono();

pinRoutes.put('/pin', authMiddleware, zValidator('json', setPinSchema), async (c) => {
  const auth = c.get('auth');
  const { currentPassword, pin } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'pin:pwd');
  if (passwordError) return passwordError;

  await setApproverPin(auth.user.id, pin);

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.pin.set',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
  });

  return c.json({ success: true });
});

// No approval decision is made here, but this DOES count against the lockout
// counter (a failed attempt increments it and can lock the PIN for 15 min). The
// authoritative L3 check happens in the approval-decision path
// (assertApprovalAssurance); this endpoint lets the UI pre-check a PIN — and
// surface lockout — before submitting a decision.
pinRoutes.post('/pin/verify', authMiddleware, zValidator('json', verifyPinSchema), async (c) => {
  const auth = c.get('auth');
  const { pin } = c.req.valid('json');

  const { verified, locked } = await verifyPinAttempt(auth.user.id, pin);

  return c.json({ verified, locked });
});
