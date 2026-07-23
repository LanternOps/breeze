import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { createConnectionService, type InitiateConsentInput, type InitiatedConsent } from './connectionService';
import {
  createGraphActionsExecutorClient,
  type GraphActionsExecutorClient,
} from './graphActionsExecutorClient';
import { loadM365CustomerGraphActionsRuntimeConfig } from './writeActionRuntimeConfig';

// --- customer-graph-actions instance -----------------------------------

const actionsConnectionService = createConnectionService({
  profile: 'customer-graph-actions',
  manifest: M365_PERMISSION_PROFILES['customer-graph-actions'],
  // Wrapped (not passed by reference) so the runtime-config binding is read
  // lazily at call time — matching the read instance's binding pattern and
  // keeping partial module mocks that omit this export importable.
  loadRuntimeConfig: () => loadM365CustomerGraphActionsRuntimeConfig(),
  createExecutorClient: (config): GraphActionsExecutorClient => createGraphActionsExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  }),
  retest: (client, request) => client.retestCustomerGraphActions(request),
  // recordEvent/recordMetric intentionally omitted, mirroring the read instance:
  // consent telemetry is emitted at the route layer, not inside the service.
  // The actions metric siblings are consumed by the actions route (Task 10).
});

/** @deprecated shape retained for parity with the read surface — use InitiateConsentInput. */
export type InitiateCustomerGraphActionsConsentInput = InitiateConsentInput;
/** @deprecated shape retained for parity with the read surface — use InitiatedConsent. */
export type InitiatedCustomerGraphActionsConsent = InitiatedConsent<'customer-graph-actions'>;

export const initiateCustomerGraphActionsConsent = actionsConnectionService.initiateConsent;
export const listCustomerGraphActionsConnections = actionsConnectionService.listConnections;
export const markAdminConsentReturned = actionsConnectionService.markAdminConsentReturned;
export const transitionAdminConsentToIdentity = actionsConnectionService.transitionAdminConsentToIdentity;
export const markConsentAttemptFailed = actionsConnectionService.markConsentAttemptFailed;
export const applyIdentityVerificationResult = actionsConnectionService.applyIdentityVerificationResult;
export const loadRetestSnapshot = actionsConnectionService.loadRetestSnapshot;
export const applyRetestResult = actionsConnectionService.applyRetestResult;
export const retestCustomerGraphActionsConnection = actionsConnectionService.retestConnection;
export const disconnectCustomerGraphActionsConnection = actionsConnectionService.disconnectConnection;

export { actionsConnectionService };
