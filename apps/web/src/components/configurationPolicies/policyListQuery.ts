import type { ConfigPolicy, ConfigPolicyStatus } from "./ConfigPolicyList";

// Wire and URL-hash helpers for the configuration-policy list (plan W03d C4).

export const LIST_PAGE_SIZE = 25;

export type PolicyListFilters = {
  page: number;
  limit: number;
  search?: string;
  status?: ConfigPolicyStatus;
  notApplied?: boolean;
  appliesToOrgId?: string | null;
};

/**
 * The GET /configuration-policies querystring (no leading `?`). Empty values
 * are omitted. The legacy `orgId` parameter is never sent: the list asks for
 * the policies an org owns and those that apply to it (`appliesToOrgId`), not
 * for every MSP-managed policy of its partner. The
 * caller must also stop fetchWithAuth adding the switcher's org as `orgId`
 * (`skipOrgIdInjection`).
 */
export function buildPolicyListQuery(filters: PolicyListFilters): string {
  const params = new URLSearchParams();
  params.set("page", String(filters.page));
  params.set("limit", String(filters.limit));
  const search = filters.search?.trim();
  if (search) params.set("search", search);
  if (filters.status) params.set("status", filters.status);
  if (filters.notApplied) params.set("notApplied", "true");
  if (filters.appliesToOrgId) params.set("appliesToOrgId", filters.appliesToOrgId);
  return params.toString();
}

export type ParsedPolicyList = {
  data: ConfigPolicy[];
  page: number;
  limit: number;
  total: number;
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Validates the literal `{ data: [...], pagination: { page, limit, total } }`
 * body. Anything else is null, so the caller shows its fetch error instead of
 * a silently empty list.
 */
export function parsePolicyListResponse(body: unknown): ParsedPolicyList | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { data, pagination } = body as { data?: unknown; pagination?: unknown };
  if (!Array.isArray(data)) return null;
  if (!pagination || typeof pagination !== "object") return null;
  const { page, limit, total } = pagination as Record<string, unknown>;
  if (!isCount(page) || !isCount(limit) || !isCount(total)) return null;
  return { data: data as ConfigPolicy[], page, limit, total };
}

export type StatusFilter = "all" | ConfigPolicyStatus;

export type ListHashState = {
  status: StatusFilter;
  notApplied: boolean;
  // undefined = follow the org switcher; "all" = explicitly every organization.
  org: string | undefined;
  search: string;
  page: number;
};

export const DEFAULT_LIST_STATE: ListHashState = {
  status: "all",
  notApplied: false,
  org: undefined,
  search: "",
  page: 1,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly StatusFilter[] = ["all", "active", "inactive", "archived"];

/** `#status=active&notApplied=1&org=<uuid|all>&q=text&page=2`; bad values default. */
export function parseListHash(hash: string): ListHashState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const status = params.get("status");
  const org = params.get("org");
  const page = Number(params.get("page"));
  const notApplied = params.get("notApplied");
  return {
    status: STATUSES.includes(status as StatusFilter) ? (status as StatusFilter) : "all",
    notApplied: notApplied === "1" || notApplied === "true",
    org: org === "all" ? "all" : org && UUID_RE.test(org) ? org : undefined,
    search: params.get("q") ?? "",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The hash payload (no leading `#`); defaults are omitted. */
export function serializeListHash(state: ListHashState): string {
  const params = new URLSearchParams();
  if (state.status !== "all") params.set("status", state.status);
  if (state.notApplied) params.set("notApplied", "1");
  if (state.org !== undefined) params.set("org", state.org);
  if (state.search) params.set("q", state.search);
  if (state.page > 1) params.set("page", String(state.page));
  return params.toString();
}
