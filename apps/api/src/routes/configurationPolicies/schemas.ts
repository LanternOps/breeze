// Re-export from shared validators (canonical location per CLAUDE.md)
export {
  createConfigPolicySchema,
  updateConfigPolicySchema,
  addFeatureLinkSchema,
  updateFeatureLinkSchema,
  assignPolicySchema,
  diffSchema,
  listConfigPoliciesSchema,
  targetQuerySchema,
  configPolicyIdParamSchema as idParamSchema,
  configPolicyLinkIdParamSchema as linkIdParamSchema,
  configPolicyAssignmentIdParamSchema as assignmentIdParamSchema,
  configPolicyDeviceIdParamSchema as deviceIdParamSchema,
  testConfigPolicyAlertRuleSchema,
} from '@breeze/shared/validators';

import { z } from 'zod';

// GET /configuration-policies/eligible-parents — which owner axis the caller is
// picking a parent for. `orgId` is required for the organization arm so the
// route can run its own canAccessOrg gate before the service filters by the
// ownership rule; the partner arm derives the partner from the token only.
export const eligibleParentsQuerySchema = z.discriminatedUnion('ownerScope', [
  z.object({ ownerScope: z.literal('organization'), orgId: z.string().guid() }),
  z.object({ ownerScope: z.literal('partner') }),
]);
