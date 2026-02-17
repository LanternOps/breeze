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
} from '@breeze/shared/validators';
