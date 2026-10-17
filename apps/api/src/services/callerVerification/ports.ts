/**
 * Injectable seams for later waves. These are NEW seams, not claims that the
 * adapters already exist: every default refuses or reports unavailable, so a
 * manually-enabled readiness flag in W01 can never manufacture assurance.
 *
 *  - `mailboxes`             W03: Graph read of the target's proxy addresses
 *  - `administrativeEligible` W05: live session/epoch/permission check for an admin step-up row
 *  - `available`             W02 (workstation) / W03 (sms, email) delivery availability
 *  - `prepare`               W02/W03: transaction-only persistence (creates the
 *                            device command / sealed link payload). Must never send.
 *  - `deliver`               W02/W03: post-commit external delivery by the publisher.
 *
 * Never persist clear link tokens in the new tables, audit, or logs.
 */
import type { EntraSubject, VerificationRow } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';

export interface CallerVerificationPorts {
  mailboxes(input: { orgId: string; target: EntraSubject }): Promise<string[]>;
  administrativeEligible(row: VerificationRow): Promise<boolean>;
  available(method: 'workstation' | 'sms' | 'email', orgId: string, deviceId?: string): Promise<boolean>;
  prepare(row: VerificationRow, token: string | null): Promise<void>;
  deliver(id: string): Promise<void>;
}

export const callerVerificationPorts: CallerVerificationPorts = {
  // W03: the target's canonical mailbox set (direct Graph / control plane /
  // Delegant). Callers wrap this in withMailboxReader + runOutsideDbContext.
  mailboxes: async ({ orgId, target }) => [...await (await import('./mailboxes')).fetchTargetMailboxes(orgId, target)],
  // W05: live refresh-family / epoch / permission re-check (lazy: administrative.ts imports permissions + db).
  administrativeEligible: async (row) => (await import('./administrative')).administrativeEligibleForRow(row),
  // W03: sms/email go to the link adapter. W02: workstation goes to the
  // workstation adapter. Both are imported lazily (they reach deliverers that
  // import the service, which imports these ports).
  available: async (method, orgId, deviceId) => {
    if (method === 'sms' || method === 'email') return (await import('./linkPorts')).linkAvailable(method);
    // Workstation readiness is per device + OS user. Without a device there is
    // nothing to check here; methodsForContact aggregates over the contact's
    // device suggestions instead.
    if (!deviceId) return false;
    return (await (await import('./workstationCapabilities')).workstationReadyUsers(orgId, deviceId)).length > 0;
  },
  prepare: async (row, token) => {
    if (row.method === 'sms' || row.method === 'email') return (await import('./linkPorts')).prepareLink(row, token);
    if (row.method === 'workstation') return (await import('./deliverers/workstation')).prepareWorkstationVerification(row);
    throw new Invalid('method_disabled', 'Delivery adapter is unavailable');
  },
  deliver: async (id) => {
    if (await (await import('./linkPorts')).deliverIfLink(id)) return;
    if (await (await import('./workstationPorts')).deliverIfWorkstation(id)) return;
    throw new Invalid('method_disabled', 'Delivery adapter is unavailable');
  },
};

export function configureCallerVerificationPorts(ports: Partial<CallerVerificationPorts>): void {
  Object.assign(callerVerificationPorts, ports);
}
