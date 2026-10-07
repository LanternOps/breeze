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

function protectedResourcesEmpty(pr: ScriptLaneEnableSaveBody['protectedResources']): boolean {
  return pr.services.length === 0 && pr.paths.length === 0 && pr.registryKeys.length === 0 && pr.deviceTags.length === 0;
}

/** The full values a save arms, in the widening-delta shape the enable
 *  branches of both policy routes hash (`effectiveGrantValues` /
 *  `effectiveCeilingValues` with every field present in the body). */
function enableWidening(body: ScriptLaneEnableSaveBody): ScriptLaneEnableGrantResource['widening'] {
  return {
    maxUnattendedRiskTier: body.maxUnattendedRiskTier,
    unattendedAllowedClasses: [...body.unattendedAllowedClasses],
    maxUnattendedPerHour: body.maxUnattendedPerHour,
    protectedResourcesEmptied: protectedResourcesEmpty(body.protectedResources),
    proposingEnabled: body.proposingEnabled,
  };
}

export function scriptLaneEnableGrantResource(
  orgId: string,
  body: ScriptLaneEnableSaveBody,
): ScriptLaneEnableGrantResource {
  return { orgId, unattendedEnabled: true, widening: enableWidening(body) };
}

/**
 * The persisted row a widening save is compared against — the policy DTO the
 * page loaded. The tier is typed as a plain string because a stored row is
 * not constrained to the two values a save may send.
 */
export interface ScriptLaneSavedValues {
  proposingEnabled: boolean;
  maxUnattendedRiskTier: string;
  unattendedAllowedClasses: string[];
  maxUnattendedPerHour: number;
  protectedResources: ScriptLaneEnableSaveBody['protectedResources'];
}

const WIDENING_TIER_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Client mirror of `computeWidening` in apps/api/src/routes/ai/scriptPolicy.ts
 * and apps/api/src/routes/partnerAiScriptPolicy.ts, for a body that carries
 * every field (which the settings page always sends). Returns the exact delta
 * the server binds a WIDENING save's step-up grant to, or null when the save
 * does not widen and needs no grant.
 *
 * Note `protectedResourcesEmptied` here is the TRANSITION (non-empty → empty),
 * not "is empty" as in the enable branch — the two branches hash different
 * values and a grant minted with the wrong one never redeems (#8096).
 */
export function scriptLaneWidening(
  saved: ScriptLaneSavedValues,
  body: ScriptLaneEnableSaveBody,
): ScriptLaneEnableGrantResource['widening'] | null {
  const tierWidened = (WIDENING_TIER_RANK[body.maxUnattendedRiskTier] ?? 0) > (WIDENING_TIER_RANK[saved.maxUnattendedRiskTier] ?? 0);
  const classesWidened = body.unattendedAllowedClasses.some((cl) => !saved.unattendedAllowedClasses.includes(cl));
  const rateWidened = body.maxUnattendedPerHour > saved.maxUnattendedPerHour;
  const protectedResourcesEmptied = !protectedResourcesEmpty(saved.protectedResources)
    && protectedResourcesEmpty(body.protectedResources);
  const proposingWidened = body.proposingEnabled && !saved.proposingEnabled;
  if (!tierWidened && !classesWidened && !rateWidened && !protectedResourcesEmptied && !proposingWidened) {
    return null;
  }
  return {
    maxUnattendedRiskTier: body.maxUnattendedRiskTier,
    unattendedAllowedClasses: [...body.unattendedAllowedClasses],
    maxUnattendedPerHour: body.maxUnattendedPerHour,
    protectedResourcesEmptied,
    proposingEnabled: body.proposingEnabled,
  };
}

/**
 * The step-up `resource` for a save that WIDENS an org's already-enabled
 * unattended lane (#8096): `PUT /ai/script-policy`'s widen branch binds the
 * grant to `{ orgId, unattendedEnabled: true, widening }`. Null when the save
 * does not widen. Only valid while the lane is enabled and stays enabled —
 * enabling uses {@link scriptLaneEnableGrantResource}.
 */
export function scriptLaneWideningGrantResource(
  orgId: string,
  saved: ScriptLaneSavedValues,
  body: ScriptLaneEnableSaveBody,
): ScriptLaneEnableGrantResource | null {
  const widening = scriptLaneWidening(saved, body);
  return widening ? { orgId, unattendedEnabled: true, widening } : null;
}

export interface PartnerScriptCeilingGrantResource {
  partnerId: string;
  unattendedAllowed: true;
  widening: ScriptLaneEnableGrantResource['widening'];
}

/**
 * The step-up `resource` for a `PUT /partner/ai/script-policy` save
 * (operation `ai_partner_script_ceiling_grant`, #8112), mirroring the route's
 * two gated branches exactly:
 *
 * - **enable** (`allowed` and the saved ceiling is not): bound to the FULL
 *   values being saved, like the org enable grant.
 * - **widen** (saved ceiling already allowed and stays allowed): bound to the
 *   {@link scriptLaneWidening} delta against the saved row.
 *
 * Returns null when the save needs no grant (disabling, a ceiling that stays
 * off, or a non-widening save of an allowed one). The caller must send
 * `unattendedAllowed` only when it changes: the route treats ANY
 * `unattendedAllowed: true` as the enable branch.
 */
export function partnerScriptCeilingGrantResource(input: {
  partnerId: string;
  allowed: boolean;
  saved: (ScriptLaneSavedValues & { unattendedAllowed: boolean }) | null;
  body: ScriptLaneEnableSaveBody;
}): PartnerScriptCeilingGrantResource | null {
  const { partnerId, allowed, saved, body } = input;
  if (!allowed) return null;
  if (!saved?.unattendedAllowed) {
    return { partnerId, unattendedAllowed: true, widening: enableWidening(body) };
  }
  const widening = scriptLaneWidening(saved, body);
  return widening ? { partnerId, unattendedAllowed: true, widening } : null;
}
