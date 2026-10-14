import './topologyZod';
import { z } from 'zod';

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: false });

export const PRESENCE_STATES = ['home', 'visiting', 'unrecognized', 'ambiguous', 'stale', 'unknown'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const PRESENCE_REASONS = [
  'not_declared', 'own_gateway_mismatch', 'own_gateway_mac_conflict', 'multiply_declared',
  'declared_unconfirmed', 'gateway_mismatch', 'consumer_uncorroborated', 'gateway_mac_conflict',
  'coverage_limited', 'no_fresh_observation', 'not_current',
] as const;
export type PresenceReason = (typeof PRESENCE_REASONS)[number];

export const presenceSiteRefSchema = z.object({ id: uuid, name: z.string().max(255) }).strict();

export const presenceNetworkSchema = z
  .object({ prefix: z.string().max(64), gatewayAddress: z.string().max(64) })
  .strict();

/**
 * Site location W3 (spec S§9, S§10): a wrong-site SUGGESTION, never an assignment. Emitted only when the viewer can
 * see both the device's assigned site and the suggested one (R2, R3, R5).
 */
export const presenceSuggestionSchema = z
  .object({
    siteId: uuid,
    siteName: z.string().max(255),
    days: z.number().int().min(0).max(366),
    firstObservedAt: timestamp,
    lastObservedAt: timestamp,
  })
  .strict();

export const presenceAssignedEntrySchema = z
  .object({
    deviceId: uuid,
    label: z.string().max(255),
    state: z.enum(PRESENCE_STATES),
    reason: z.enum(PRESENCE_REASONS).nullable(),
    matchedSite: presenceSiteRefSchema.nullable(),
    declaringSites: z.array(presenceSiteRefSchema).max(8).nullable(),
    network: presenceNetworkSchema.nullable(),
    macCorroborated: z.boolean(),
    observedAt: timestamp.nullable(),
    freshUntil: timestamp.nullable(),
    suggestion: presenceSuggestionSchema.nullable(),
    /** W3 (S§11): "Keep at <site>" was chosen; suggestions are off for this device until it moves or this is cleared. */
    siteAssignmentConfirmedAt: timestamp.nullable(),
  })
  .strict();

/** Strict on purpose: a visitor carries no canonical node id (spec R6). */
export const presenceVisitorSchema = z
  .object({
    id: z.string().regex(/^presentation:overview:[^:]{1,128}:visitor-[0-9a-f]{40}$/),
    deviceId: uuid,
    label: z.string().max(255),
    assignedSite: presenceSiteRefSchema,
    network: presenceNetworkSchema,
    macCorroborated: z.boolean(),
    observedAt: timestamp.nullable(),
    freshUntil: timestamp.nullable(),
    suggestion: presenceSuggestionSchema.nullable(),
    siteAssignmentConfirmedAt: timestamp.nullable(),
  })
  .strict();

export const presenceDeclaredNetworkSchema = z
  .object({
    prefix: z.string().max(64),
    sources: z.array(z.enum(['discovery_profile', 'network_baseline'])).max(2),
    status: z.enum(['anchored', 'unconfirmed', 'ambiguous']),
    gatewayAddresses: z.array(z.string().max(64)).max(16),
  })
  .strict();

export const presenceResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    siteId: uuid,
    asOf: timestamp,
    authority: z.literal(false),
    coverage: z.enum(['complete', 'limited', 'not_configured']),
    ignoredDeclarations: z.number().int().min(0),
    declaredNetworks: z.array(presenceDeclaredNetworkSchema).max(256),
    assigned: z.array(presenceAssignedEntrySchema).max(1000),
    visitors: z.array(presenceVisitorSchema).max(500),
    counts: z
      .object({
        observedElsewhere: z.number().int().min(0),
        unidentified: z.number().int().min(0),
        unknown: z.number().int().min(0),
        visiting: z.number().int().min(0),
      })
      .strict(),
    truncated: z.object({ assigned: z.boolean(), visitors: z.boolean() }).strict(),
  })
  .strict();

export type PresenceSiteRef = z.infer<typeof presenceSiteRefSchema>;
export type PresenceSuggestion = z.infer<typeof presenceSuggestionSchema>;
export type PresenceAssignedEntry = z.infer<typeof presenceAssignedEntrySchema>;
export type PresenceVisitor = z.infer<typeof presenceVisitorSchema>;
export type PresenceDeclaredNetwork = z.infer<typeof presenceDeclaredNetworkSchema>;
export type PresenceResponse = z.infer<typeof presenceResponseSchema>;
