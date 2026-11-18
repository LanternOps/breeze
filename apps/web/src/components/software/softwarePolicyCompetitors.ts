/**
 * #9635 — a device follows ONE software policy. These helpers render the API's
 * "which policy wins instead" detail (GET /software-policies/:id/coverage and
 * the SOFTWARE_POLICY_WOULD_NOT_APPLY refusal from Inventory Approve / Deny).
 */
import { i18n } from "@/lib/i18n";

export const SOFTWARE_POLICY_WOULD_NOT_APPLY = "SOFTWARE_POLICY_WOULD_NOT_APPLY";

export type SoftwarePolicyCompetitor = {
  policyId: string | null;
  name: string | null;
  mode: string | null;
  partnerWide: boolean;
  configPolicyId: string;
  configPolicyName: string | null;
  deviceCount: number;
};

export type SoftwarePolicyCoverage = {
  assignedDeviceCount: number;
  appliesToDeviceCount: number;
  overriddenBy: SoftwarePolicyCompetitor[];
};

/** `"Default Allowlist"`, `partner-wide "MSP Blocklist"`, or "another software policy". */
export function competitorLabel(c: SoftwarePolicyCompetitor): string {
  if (!c.name) return i18n.t("policies:software.policyCoverage.anotherPolicy");
  const quoted = `"${c.name}"`;
  return c.partnerWide
    ? i18n.t("policies:software.policyCoverage.partnerWide", { name: quoted })
    : quoted;
}

export function competitorList(list: SoftwarePolicyCompetitor[]): string {
  return list.map(competitorLabel).join(", ");
}

type RefusalBody = {
  policyName?: unknown;
  sameMode?: unknown;
  winners?: unknown;
};

/** User-facing copy for a SOFTWARE_POLICY_WOULD_NOT_APPLY refusal, or undefined if the body lacks detail. */
export function wouldNotApplyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { policyName, sameMode, winners } = body as RefusalBody;
  if (typeof policyName !== "string" || !Array.isArray(winners) || winners.length === 0) {
    return undefined;
  }
  const list = winners as SoftwarePolicyCompetitor[];
  const primary = list[0]!;
  if (sameMode === true && primary.name) {
    return i18n.t("policies:software.softwareInventory.policyWouldNotApplySameMode", {
      policy: policyName,
      winners: competitorList(list),
      winner: `"${primary.name}"`,
    });
  }
  return i18n.t("policies:software.softwareInventory.policyWouldNotApply", {
    policy: policyName,
    winners: competitorList(list),
    configPolicy: primary.configPolicyName
      ? `"${primary.configPolicyName}"`
      : i18n.t("policies:software.softwareInventory.theWinningConfigPolicy"),
  });
}
