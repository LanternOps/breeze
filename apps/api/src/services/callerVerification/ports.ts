/**
 * Injectable seams for later waves. These are NEW seams, not claims that the
 * adapters already exist: every default refuses or reports unavailable, so a
 * manually-enabled readiness flag in W01 can never manufacture assurance.
 *
 *  - `mailboxes`             W03: Graph read of the target's proxy addresses
 *  - `administrativeEligible` W05: DB/session-state check for an admin step-up row
 *  - `consumeStepUp`         W05: interactive step-up proof consumer
 *  - `available`             W02 (workstation) / W03 (sms, email) delivery availability
 *  - `prepare`               W02/W03: transaction-only persistence (creates the
 *                            device command / sealed link payload). Must never send.
 *  - `deliver`               W02/W03: post-commit external delivery by the publisher.
 *
 * Never persist clear link tokens in the new tables, audit, or logs.
 */
import type { CallerVerificationActor, EntraSubject, VerificationRow } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';

export interface CallerVerificationPorts {
  mailboxes(input: { orgId: string; target: EntraSubject }): Promise<string[]>;
  administrativeEligible(row: VerificationRow): Promise<boolean>;
  consumeStepUp(
    actor: CallerVerificationActor,
    input: { orgId: string; target: EntraSubject; reason: string; stepUpGrantId: string },
  ): Promise<{ sid: string; authEpoch: number; mfaEpoch: number }>;
  available(method: 'workstation' | 'sms' | 'email', orgId: string, deviceId?: string): Promise<boolean>;
  prepare(row: VerificationRow, token: string | null): Promise<void>;
  deliver(id: string): Promise<void>;
}

export const callerVerificationPorts: CallerVerificationPorts = {
  mailboxes: async () => { throw new Invalid('subject_mailboxes_unknown', 'Mailbox read adapter is unavailable'); },
  administrativeEligible: async () => false,
  consumeStepUp: async () => { throw new Invalid('stepup_invalidated', 'Interactive step-up adapter is unavailable'); },
  available: async () => false,
  prepare: async () => { throw new Invalid('method_disabled', 'Delivery adapter is unavailable'); },
  deliver: async () => { throw new Invalid('method_disabled', 'Delivery adapter is unavailable'); },
};

export function configureCallerVerificationPorts(ports: Partial<CallerVerificationPorts>): void {
  Object.assign(callerVerificationPorts, ports);
}
