import { fetchWithAuth } from "../stores/auth";
import { throwIfNotOk } from "@/lib/httpError";

export const COVERAGE_STATES = [
  "covered",
  "gap",
  "vendor_only",
  "vendor_offline",
  "mismatched_org",
  "not_applicable",
  "pending",
] as const;

export type CoverageState = (typeof COVERAGE_STATES)[number];

export function isCoverageState(value: unknown): value is CoverageState {
  return (
    typeof value === "string" &&
    (COVERAGE_STATES as readonly string[]).includes(value)
  );
}

export type CoverageCounts = Record<CoverageState, number>;

export interface CoverageVendorSummary {
  vendor: string;
  total: number;
  counts: Partial<CoverageCounts>;
}

export interface CoverageRow {
  id: string;
  orgId: string;
  deviceId: string | null;
  deviceName: string | null;
  vendor: string;
  state: CoverageState | string;
  reasonCode: string | null;
  detail: string | null;
  lastEvaluatedAt: string;
  stateChangedAt: string;
}

export interface CoverageResponse {
  summary: CoverageVendorSummary[];
  data: CoverageRow[];
  pagination: { limit: number; offset: number; total: number };
}

export interface CoverageParams {
  orgId?: string | null;
  deviceId?: string;
  vendor?: string;
  states?: CoverageState[];
  limit?: number;
  offset?: number;
}

/** Brand names: never translated. */
const VENDOR_LABELS: Record<string, string> = {
  huntress: "Huntress",
  sentinelone: "SentinelOne",
  controld: "Control D",
  nextdns: "NextDNS",
};

export function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor;
}

export function buildCoverageQuery(params: CoverageParams): string {
  const q = new URLSearchParams();
  if (params.orgId) q.set("orgId", params.orgId);
  if (params.deviceId) q.set("deviceId", params.deviceId);
  if (params.vendor) q.set("vendor", params.vendor);
  if (params.states && params.states.length > 0) {
    q.set("state", params.states.join(","));
  }
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchSecurityAgentCoverage(
  params: CoverageParams = {},
): Promise<CoverageResponse> {
  const res = await fetchWithAuth(
    `/edr/security-agents/coverage${buildCoverageQuery(params)}`,
  );
  throwIfNotOk(res);
  const body = (await res.json()) as Partial<CoverageResponse>;
  if (!Array.isArray(body.summary) || !Array.isArray(body.data)) {
    throw new Error("malformed coverage response");
  }
  const rows = body.data;
  return {
    summary: body.summary,
    data: rows,
    pagination: body.pagination ?? {
      limit: rows.length,
      offset: 0,
      total: rows.length,
    },
  };
}

/** Sum per-vendor counts into one count per state. */
export function totalCounts(summary: CoverageVendorSummary[]): CoverageCounts {
  const out = Object.fromEntries(
    COVERAGE_STATES.map((s) => [s, 0]),
  ) as CoverageCounts;
  for (const v of summary) {
    for (const s of COVERAGE_STATES) out[s] += v.counts?.[s] ?? 0;
  }
  return out;
}

const STATE_KEYS: Record<CoverageState, string> = {
  covered: "covered",
  gap: "gap",
  vendor_only: "vendorOnly",
  vendor_offline: "vendorOffline",
  mismatched_org: "mismatchedOrg",
  not_applicable: "notApplicable",
  pending: "pending",
};

const REASON_KEYS: Record<string, string> = {
  org_not_mapped: "orgNotMapped",
  integration_inactive: "integrationInactive",
  org_key_missing: "orgKeyMissing",
  account_key_missing: "accountKeyMissing",
  platform_unsupported: "platformUnsupported",
  requires_mdm_approval: "requiresMdmApproval",
  platform_not_selected: "platformNotSelected",
  var_missing: "varMissing",
  vendor_unavailable: "vendorUnavailable",
  install_failed: "installFailed",
  install_not_armed: "installNotArmed",
  install_pending: "installPending",
  awaiting_vendor_report: "awaitingVendorReport",
  awaiting_evaluation: "awaitingEvaluation",
  vendor_org_mismatch: "vendorOrgMismatch",
};

type TFn = (key: string) => string;

export function coverageStateLabel(t: TFn, state: string): string {
  const key = isCoverageState(state) ? STATE_KEYS[state] : null;
  return key ? t(/* i18n-dynamic */ `security:securityAgentCoverage.states.${key}`) : state;
}

/** Translated reason label; an unknown code falls back to the raw code. */
export function coverageReasonLabel(t: TFn, code: string | null): string {
  if (!code) return "";
  const key = REASON_KEYS[code];
  return key ? t(/* i18n-dynamic */ `security:securityAgentCoverage.reasons.${key}`) : code;
}

const STATE_CLASSES: Record<CoverageState, string> = {
  covered: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  gap: "bg-red-500/15 text-red-700 border-red-500/30",
  vendor_only: "bg-amber-500/15 text-amber-800 border-amber-500/40",
  vendor_offline: "bg-orange-500/15 text-orange-700 border-orange-500/40",
  mismatched_org: "bg-amber-500/15 text-amber-800 border-amber-500/40",
  not_applicable: "bg-muted text-muted-foreground border-border",
  pending: "bg-blue-500/15 text-blue-700 border-blue-500/30",
};

export function coverageStateClass(state: string): string {
  return isCoverageState(state)
    ? STATE_CLASSES[state]
    : "bg-muted text-muted-foreground border-border";
}
