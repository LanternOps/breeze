import type { AuthContext } from '../../middleware/auth';
import type {
  TopologyTemplatePreview,
  TopologyTemplateSiteOutcome,
} from '@breeze/shared';
import type { ApprovedTopologySiteEffect } from './siteConfiguration';

/** Claims and ceilings, never a bearer token or reusable execution grant. */
export type ApplicationActor = Pick<
  AuthContext,
  | 'user'
  | 'principal'
  | 'scope'
  | 'orgId'
  | 'partnerId'
  | 'accessibleOrgIds'
  | 'partnerOrgAccess'
> & {
  // Declared in the body (not the Pick) so aiToolsActorParity.contract.test.ts
  // sees the site axis; same optional shape as AuthContext.
  allowedSiteIds?: AuthContext['allowedSiteIds'];
  authEpoch: number;
  mfaEpoch: number;
  mfa: boolean;
};
export interface TemplateApplicationRecord {
  version: 1;
  requesterId: string;
  originalOrgId: string;
  actor: ApplicationActor;
  previewId: string;
  tokenDigest: string;
  permissionVersion: string;
  expiresAt: string;
  effectDigest: string;
  effect: ApprovedTopologySiteEffect | null;
  preview: TopologyTemplatePreview['sites'][number];
  operationId?: string;
  idempotencyDigest?: string;
  outcome?: TopologyTemplateSiteOutcome;
}
export const PREVIEW_EVENT = 'template.application.preview';
export const INTENT_EVENT = 'template.application.intent';
export const PREVIEW_TTL_MS = 10 * 60_000;
