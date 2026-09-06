// Pure helpers for the UniFi integration panel, split out of
// UnifiIntegration.tsx (#2382) — no behavior change, verbatim moves.

import { fetchAllDevices } from "@/lib/devicesFetch";
import type { AgentDevice } from "./unifiTypes";

// Label for a collector-agent <option>. Empty/whitespace names must fall
// through the same way nulls do — `displayName: ""` survives the API write
// schemas, and a blank option is worse than the UUID this replaced: it is
// indistinguishable from the placeholder and from every other blank row.
// `(displayName || hostname || id).trim()` matches the primary device surfaces
// (DeviceList, DeviceDetails, NetworkChangesPanel), so a device cannot read as
// one name there and blank here.
export function agentLabel(agent: AgentDevice): string {
  const label = agent.displayName?.trim() || agent.hostname?.trim();
  if (label) return label;
  // Unreachable for well-formed rows: devices.hostname is NOT NULL and is always
  // selected by GET /devices. Reaching here means the response shape drifted —
  // precisely the #3121 failure mode — so say so rather than silently showing a
  // UUID for every row again.
  console.warn(
    "[unifi] agent device has neither displayName nor hostname; falling back to id",
    agent.id,
  );
  return agent.id;
}

// A collector polls the controller from the agent, so an offline agent yields a
// collector that silently never polls. Annotate rather than filter: an agent
// that is down right now is still a legitimate choice to configure, but the
// operator has to be able to see what they are picking. The status label is
// translated out of the `devices` namespace, which already carries the full
// device_status enum in every locale — an English "(offline)" inside otherwise
// localized copy is its own small version of showing the user the wrong thing.
export function agentOptionLabel(
  agent: AgentDevice,
  translateStatus: (status: string) => string,
): string {
  const name = agentLabel(agent);
  const status = agent.status?.trim().toLowerCase();
  return !status || status === "online"
    ? name
    : `${name} (${translateStatus(status)})`;
}

// Row-level validation for the device rows `fetchAllDevices` accumulated.
//
// The envelope is the walker's problem (it is the reviewed, shared unwrapper);
// what it cannot know is whether the ROWS carry the fields this picker reads.
// That gap is exactly #3121: the rows arrived fine, but under a field name this
// file did not read, and nothing anywhere said so. `ok` on the request tells you
// nothing about that, so check it explicitly and fail loudly.
type AgentRowsResult =
  | { ok: true; devices: AgentDevice[] }
  | { ok: false; reason: string };

function validateAgentRows(
  rows: Record<string, unknown>[],
  total: number | undefined,
): AgentRowsResult {
  // A healthy response always reports a count — `fetchAllDevices` sets
  // includeTotal on the first page. Zero rows AND no count means the body
  // carried no recognizable pagination at all (an error object served with
  // HTTP 200, a renamed envelope), which is drift wearing an empty fleet's
  // clothes. Zero rows WITH total===0 is a real empty fleet and stays silent —
  // a guard that fires for every device-less partner is noise and gets ignored.
  if (rows.length === 0) {
    return total === undefined
      ? { ok: false, reason: "empty body with no pagination total" }
      : { ok: true, devices: [] };
  }
  const usable = rows.filter(
    (row): row is AgentDevice & Record<string, unknown> =>
      row !== null &&
      typeof row === "object" &&
      typeof (row as { id?: unknown }).id === "string" &&
      ("hostname" in row || "displayName" in row),
  );
  // All-or-nothing would let a PARTIAL drift through silently: some rows
  // recognized, the rest filtered out of the dropdown with no warning — the
  // same "my agent isn't in the list" symptom, and harder to spot than a total
  // failure. Any unusable row is drift.
  if (usable.length !== rows.length) {
    const sample = rows.find(
      (row) => row !== null && typeof row === "object" && !usable.includes(row as never),
    );
    const keys = sample ? Object.keys(sample).join(", ") : "non-object row";
    return {
      ok: false,
      reason: `${rows.length - usable.length} of ${rows.length} device rows lack id/hostname/displayName (sample keys: ${keys})`,
    };
  }
  return { ok: true, devices: usable };
}

// Shared agent load for both loaders.
//
// `fetchAllDevices` walks the keyset cursor to completion instead of taking one
// capped page. That matters: this picker filters by site CLIENT-side, so a
// partner past the old `?limit=500` ceiling simply could not reach their agent —
// and a notice explaining that would have been a label on a broken control
// rather than a fix. Truncation now means only the walker's 40,000-row safety
// ceiling, which is why the notice can stay quiet in normal operation.
export type AgentLoad =
  | { kind: "ok"; devices: AgentDevice[]; truncated: boolean }
  | { kind: "unauthorized" }
  | { kind: "failed"; label: string };

export async function loadAgentDevices(): Promise<AgentLoad> {
  let truncated = false;
  try {
    const { data, total } = await fetchAllDevices({
      // The route already hides decommissioned devices unless asked; preserve
      // that. A decommissioned box is not a collector candidate.
      includeDecommissioned: false,
      onTruncated: () => {
        truncated = true;
      },
    });
    const parsed = validateAgentRows(data, total);
    if (!parsed.ok) {
      console.warn("[unifi] GET /devices response drift:", parsed.reason);
      return {
        kind: "failed",
        label: "agent devices (unexpected response format)",
      };
    }
    return { kind: "ok", devices: parsed.devices, truncated };
  } catch (err) {
    // fetchAllDevices rejects with the failed Response itself. Duck-type the
    // status so a test double (a plain object) behaves like a real Response.
    if ((err as { status?: unknown } | null)?.status === 401) {
      return { kind: "unauthorized" };
    }
    return { kind: "failed", label: "agent devices" };
  }
}

// Sync-run status → badge colors (mirrors SyncRunResult.status: success | partial | failed,
// plus the transient 'running' the worker writes at start).
export function runStatusClasses(status: string): string {
  switch (status) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "partial":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "failed":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

// Collector status → badge colors (unifi_collectors.status:
// pending | connected | unreachable | error | firmware_too_old).
export function collectorStatusClasses(status: string): string {
  switch (status) {
    case "connected":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "unreachable":
    case "firmware_too_old":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "error":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}
