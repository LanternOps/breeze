/**
 * Portal directory deprovisioning (portal registration W8 #11385) — the public
 * API for routes and other services. The worker module is loaded lazily by
 * services/workerRegistry.ts; the M365 sync hook imports `./entraCapture`
 * directly.
 */
export { captureEntraDirectoryRun, type EntraCaptureContext, type EntraCaptureResult } from './entraCapture';
export { directoryMode, isDirectoryDeprovisionEnforced } from './mode';
export { PORTAL_DIRECTORY_QUEUE, enqueueApplyRun } from './queue';
export {
  applyRun,
  dismissHeldRun,
  impactDigestOf,
  type RunDisposition,
  type RunRefusalReason,
} from './runStore';
export {
  PortalDirectoryIdentityError,
  disablePortalIdentity,
  removeDisabledPortalIdentity,
  restorePortalIdentity,
  type PortalDirectoryIdentityErrorCode,
} from './identityDisable';
export {
  getPortalDirectoryStatus,
  type ActionRow,
  type PortalDirectoryStatus,
  type RunSummary,
} from './status';
export type { DirectorySource, IdentityBlocker, IdentityDisabledReason } from './types';
