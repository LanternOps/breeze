import type { z } from 'zod';
import type { topologyConfigurationSchema, topologyTargetDefinitionSchema, topologyPolicyDefinitionSchema } from '../validators/topologyConfiguration';

export type TopologyConfigurationPayload = z.infer<typeof topologyConfigurationSchema>;
export type TopologyTargetDefinition = z.infer<typeof topologyTargetDefinitionSchema>;
export type TopologyPolicyDefinition = z.infer<typeof topologyPolicyDefinitionSchema>;

import type { resolvedTopologySettingsSchema, topologySiteSettingsSchema, topologySiteSettingsPatchSchema, topologyRuntimeCapabilitiesSchema, topologyTemplateVersionSchema, topologyTemplateVersionListSchema, topologyTemplatePreviewRequestSchema, topologyTemplatePreviewSchema, topologyTemplateSiteOutcomeSchema, topologyTemplateApplicationSchema } from '../validators/topologyConfiguration';
export type ResolvedTopologySettings = z.infer<typeof resolvedTopologySettingsSchema>;
export type TopologySiteSettings = z.infer<typeof topologySiteSettingsSchema>;
export type TopologySiteSettingsPatch = z.infer<typeof topologySiteSettingsPatchSchema>;
export type TopologyRuntimeCapabilities = z.infer<typeof topologyRuntimeCapabilitiesSchema>;
export type TopologyTemplateVersion = z.infer<typeof topologyTemplateVersionSchema>;
export type TopologyTemplateVersionList = z.infer<typeof topologyTemplateVersionListSchema>;
export type TopologyTemplatePreviewRequest = z.infer<typeof topologyTemplatePreviewRequestSchema>;
export type TopologyTemplatePreview = z.infer<typeof topologyTemplatePreviewSchema>;
export type TopologyTemplateSiteOutcome = z.infer<typeof topologyTemplateSiteOutcomeSchema>;
export type TopologyTemplateApplication = z.infer<typeof topologyTemplateApplicationSchema>;
