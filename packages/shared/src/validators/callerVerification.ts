/**
 * Caller verification (anti-vishing, #6354) request contracts.
 * Spec: docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md
 */
import { z } from 'zod';

const id = z.string().uuid();
/** Methods a technician can START. `administrative_stepup` has its own W05 route. */
const method = z.enum(['workstation', 'sms', 'email', 'callback_attestation']);
const action = z.enum(['reset_password', 'disable_user', 'any']);
const reason = z.string().trim().min(20).max(4000);

export const startCallerVerificationSchema = z.object({
  contactId: id,
  targetContactId: id.optional(),
  method,
  actionScope: action,
  deviceId: id.optional(),
  username: z.string().trim().min(1).max(255).optional(),
  ticketId: id.optional(),
  note: z.string().trim().max(4000).optional(),
}).strict().superRefine((v, c) => {
  if (v.method === 'workstation' && (!v.deviceId || !v.username)) {
    c.addIssue({ code: 'custom', path: ['deviceId'], message: 'Workstation requires deviceId and username' });
  }
  if (v.targetContactId && v.targetContactId !== v.contactId && v.actionScope !== 'disable_user') {
    c.addIssue({ code: 'custom', path: ['targetContactId'], message: 'Only disable_user permits a different target' });
  }
});

export const attestCallerVerificationSchema = z.object({ note: z.string().trim().min(20).max(4000) }).strict();

export const callerVerificationBindingSchema = z.object({
  entraTenantId: id,
  entraOid: id,
  upn: z.string().trim().max(320).nullable(),
}).strict();

export const callerVerificationFenceOverrideSchema = z.object({ reason }).strict();

export const administrativeCallerVerificationSchema = z.object({
  targetContactId: id,
  reason,
  stepUpGrantId: id,
}).strict();

export const callerVerificationMethodsQuerySchema = z.object({ actionScope: action.default('any') });

/** Contact role vocabulary (apps/api services/contacts/types.ts CONTACT_ROLES). */
const contactRole = z.enum(['billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal']);
const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

/**
 * Policy patch. Every field is nullable: null/omitted means "inherit" from
 * the partner baseline (or code defaults). No client-side defaults — the
 * server's baseline-then-tighten resolver is the single source of truth.
 */
export const callerVerificationPolicySchema = z.object({
  requiredTierResetPassword: nullable(z.number().int().min(0).max(3)),
  requiredTierDisableUser: nullable(z.number().int().min(0).max(3)),
  disableUserAuthorizerRoles: nullable(z.array(contactRole).max(7)),
  verificationTtlMinutes: nullable(z.number().int().min(5).max(240)),
  allowedMethods: nullable(z.array(method).max(4)),
  workstationTimeoutSeconds: nullable(z.number().int().min(30).max(300)),
  destinationMinAgeDays: nullable(z.number().int().min(0).max(90)),
  requireAttestedDestination: nullable(z.boolean()),
  requireTicket: nullable(z.boolean()),
  allowCrossTechnicianUse: nullable(z.boolean()),
  allowAdministrativeDisable: nullable(z.boolean()),
  maxAttemptsPerHour: nullable(z.number().int().min(1).max(100)),
  coolingOffHours: nullable(z.number().int().min(1).max(720)),
}).strict();

export type StartCallerVerificationInput = z.infer<typeof startCallerVerificationSchema>;
export type CallerVerificationPolicyPatch = z.infer<typeof callerVerificationPolicySchema>;
