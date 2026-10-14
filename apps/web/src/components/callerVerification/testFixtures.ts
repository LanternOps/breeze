import type {
  ContactHistory,
  EffectiveCallerVerificationPolicy,
  MethodAvailability,
  PolicyResponse,
  PolicyValues,
  VerificationDetails,
} from '@/lib/api/callerVerification';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const CONTACT = '22222222-2222-4222-8222-222222222222';
export const TARGET = '33333333-3333-4333-8333-333333333333';
export const USER = '44444444-4444-4444-8444-444444444444';
export const TICKET = '66666666-6666-4666-8666-666666666666';

export const row: VerificationDetails = {
  id: '55555555-5555-4555-8555-555555555555', orgId: ORG, contactId: CONTACT,
  targetContactId: null, method: 'sms', status: 'pending', tier: 2,
  tierReason: 'destination_established', actionScope: 'reset_password', targetLabel: 'Ada',
  technicianLabel: 'Technician', initiatedByUserId: USER, expiresAt: '2026-09-19T12:10:00Z',
  decidedAt: null, consumedAt: null, ticketRef: null, ticketNumber: null,
  destinationRedacted: '+1 •••• 12', deviceHostname: null, osUsername: null,
  createdAt: '2026-09-19T12:00:00Z', secrets: { matchValue: '42', decoyValues: ['13', '87'], reverseCode: '7319' },
  remainingAttempts: 2, usableUntil: null, incidentId: null, consumedAction: null, undeliverableReason: null,
};

export const policyValues: PolicyValues = {
  requiredTierResetPassword: 2, requiredTierDisableUser: 2, disableUserAuthorizerRoles: ['admin'],
  verificationTtlMinutes: 30, allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'],
  workstationTimeoutSeconds: 120, destinationMinAgeDays: 7, requireAttestedDestination: false,
  requireTicket: false, allowCrossTechnicianUse: false, allowAdministrativeDisable: true,
  maxAttemptsPerHour: 3, coolingOffHours: 24,
};

export const policy: EffectiveCallerVerificationPolicy = { ...policyValues, provenance: {}, ignored: [] };

export const policyResponse: PolicyResponse = { row: null, defaults: policyValues, baseline: policyValues, effective: policy };

export const history: ContactHistory = { rows: [], fencedUntil: null, bindings: [], destinations: [] };

export const methods: MethodAvailability[] = [
  { method: 'workstation', available: false, tier: 1, reason: 'unbound_principal', unavailableReason: 'helper_outdated' },
  { method: 'sms', available: true, tier: 2, reason: 'destination_established' },
  { method: 'email', available: false, tier: 1, reason: 'destination_recent', unavailableReason: 'no_destination' },
  { method: 'callback_attestation', available: true, tier: 1, reason: 'attestation' },
];
