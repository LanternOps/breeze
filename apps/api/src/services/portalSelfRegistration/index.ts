/**
 * Customer-portal self-registration by verified email domain (portal
 * registration W6) — public API for the routes. The worker module is loaded
 * lazily by services/workerRegistry.ts.
 */
export { emailDomainOf } from './emailDomain';
export { resolveSelfRegistrationTarget } from './eligibility';
export { enqueuePortalSelfRegistration } from './queue';
export {
  PORTAL_SELF_REGISTRATION_QUEUE,
  type PortalSelfRegistrationJobData,
  type SelfRegistrationIneligibleReason,
  type SelfRegistrationMode,
  type SelfRegistrationTarget,
} from './types';
