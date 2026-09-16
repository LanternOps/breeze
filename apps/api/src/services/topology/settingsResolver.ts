import {
  topologyConfigurationSchema,
  topologyResolvedConfigurationSchema,
  type TopologyConfigurationPayload,
  type ResolvedTopologySettings,
} from '@breeze/shared';
import {
  canonicalizeArguments,
  computeArgumentDigest,
} from '@breeze/shared/canonicalize';
import { z } from 'zod';
import type { TopologySettingsLayers } from './configurationTypes';

export const TOPOLOGY_DEFAULT_CONFIGURATION: TopologyConfigurationPayload = {
  passive: {
    enabled: true,
    intervalSeconds: 300,
    neighbors: true,
    routingRules: true,
  },
  outboundEnabled: false,
  targets: {},
  policies: {},
};
/** Version-pinned, field-specific merge. A named object is never recursively merged. */
export function resolveTopologySettings(
  input: TopologySettingsLayers,
): ResolvedTopologySettings {
  const versions = z
    .object({
      defaultsVersion: z.literal(1),
      schemaVersion: z.literal(1),
      resolverVersion: z.literal(1),
    })
    .parse(input);
  const settings: TopologyConfigurationPayload = { targets: {}, policies: {} };
  const provenance: ResolvedTopologySettings['provenance'] = {};
  const validationEffects: ResolvedTopologySettings['validationEffects'] = [];
  const layers = [
    { layer: 'defaults' as const, versionId: null, payload: input.defaults },
    ...(input.partner
      ? [
          {
            layer: 'partner' as const,
            versionId: z.uuid().parse(input.partner.versionId),
            payload: input.partner.payload,
          },
        ]
      : []),
    ...(input.organization
      ? [
          {
            layer: 'organization' as const,
            versionId: z.uuid().parse(input.organization.versionId),
            payload: input.organization.payload,
          },
        ]
      : []),
    ...(input.site
      ? [{ layer: 'site' as const, versionId: null, payload: input.site }]
      : []),
  ];
  for (const { layer, versionId, payload } of layers) {
    const parsed = topologyConfigurationSchema.parse(payload);
    for (const field of [
      'enabled',
      'intervalSeconds',
      'neighbors',
      'routingRules',
    ] as const) {
      const value = parsed.passive?.[field];
      if (value === undefined) continue;
      settings.passive = { ...settings.passive, [field]: value };
      provenance[`passive.${field}`] = { layer, versionId };
    }
    if (parsed.outboundEnabled !== undefined) {
      settings.outboundEnabled = parsed.outboundEnabled;
      provenance.outboundEnabled = { layer, versionId };
    }
    for (const field of ['targets', 'policies'] as const) {
      for (const [key, entry] of Object.entries(parsed[field])) {
        const path = `${field}.${key}`;
        if (entry.kind === 'tombstone') {
          delete settings[field][key];
          validationEffects.push({
            field: path,
            action: 'remove',
            capability: 'monitoringTargets',
            reason: null,
          });
        } else {
          // Keep the discriminated target/policy union intact through assignment.
          Object.assign(settings[field], { [key]: structuredClone(entry) });
        }
        provenance[path] = { layer, versionId };
      }
    }
  }
  const resolved = topologyResolvedConfigurationSchema.parse(settings);
  const digest = computeArgumentDigest(
    canonicalizeArguments({ ...versions, settings: resolved }),
  );
  return { settings: resolved, digest, provenance, validationEffects };
}
