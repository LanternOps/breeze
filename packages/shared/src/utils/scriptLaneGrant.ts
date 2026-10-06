/**
 * The step-up `resource` for turning the unattended script lane ON (#7873).
 *
 * `PUT /ai/script-policy`'s enable branch binds the grant to the full set of
 * values the save arms (`effectiveGrantValues` in
 * apps/api/src/routes/ai/scriptPolicy.ts), not just the boolean, so a grant
 * minted for a bare `{ orgId, unattendedEnabled: true }` never matches and the
 * save re-prompts forever. Mint with this builder, from the SAME body you PUT.
 *
 * The body must carry every field: the server fills an omitted field from the
 * org's existing row, which the client cannot reproduce reliably, so the
 * builder takes them all and the digest then depends on the body alone.
 */
export interface ScriptLaneEnableSaveBody {
  proposingEnabled: boolean;
  maxUnattendedRiskTier: 'low' | 'medium';
  unattendedAllowedClasses: string[];
  maxUnattendedPerHour: number;
  protectedResources: {
    services: string[];
    paths: string[];
    registryKeys: string[];
    deviceTags: string[];
  };
}

export interface ScriptLaneEnableGrantResource {
  orgId: string;
  unattendedEnabled: true;
  widening: {
    maxUnattendedRiskTier: 'low' | 'medium';
    unattendedAllowedClasses: string[];
    maxUnattendedPerHour: number;
    protectedResourcesEmptied: boolean;
    proposingEnabled: boolean;
  };
}

export function scriptLaneEnableGrantResource(
  orgId: string,
  body: ScriptLaneEnableSaveBody,
): ScriptLaneEnableGrantResource {
  const pr = body.protectedResources;
  return {
    orgId,
    unattendedEnabled: true,
    widening: {
      maxUnattendedRiskTier: body.maxUnattendedRiskTier,
      unattendedAllowedClasses: [...body.unattendedAllowedClasses],
      maxUnattendedPerHour: body.maxUnattendedPerHour,
      protectedResourcesEmptied:
        pr.services.length === 0 && pr.paths.length === 0 && pr.registryKeys.length === 0 && pr.deviceTags.length === 0,
      proposingEnabled: body.proposingEnabled,
    },
  };
}
