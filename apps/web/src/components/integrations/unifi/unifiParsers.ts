// Response parsers for the UniFi panel. These are standalone (not inline casts
// in the hook) so a unit test can call them directly: a parser that rebuilds
// objects field by field would silently drop a new API field while a
// fetch-mocked component test still passed. Each one spreads the raw object
// first and then normalizes the fields the UI depends on.

import type {
  HostKeyOutcome,
  HostsResponse,
  SyncRun,
  SyncRunKeyResult,
  UnifiHostOption,
  UnifiKeySummary,
  UnifiStatus,
} from "./unifiTypes";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === "string");

export function parseUnifiKeySummaries(value: unknown): UnifiKeySummary[] {
  return asArray(value)
    .filter(isObj)
    .map((k) => ({ ...k }) as unknown as UnifiKeySummary);
}

export function parseUnifiStatus(json: unknown): UnifiStatus {
  const raw = isObj(json) ? json : {};
  const status = { ...raw } as unknown as UnifiStatus;
  if ("keys" in raw) status.keys = parseUnifiKeySummaries(raw.keys);
  return status;
}

export function parseHostsResponse(json: unknown): HostsResponse {
  const raw = isObj(json) ? json : {};
  const hosts = asArray(raw.hosts)
    .filter(isObj)
    .map((h) => ({
      ...h,
      keyIds: strings(h.keyIds),
      sites: asArray(h.sites)
        .filter(isObj)
        .map((s) => ({ ...s, keyIds: strings(s.keyIds) })),
    })) as unknown as UnifiHostOption[];
  const keys = asArray(raw.keys)
    .filter(isObj)
    .map((k) => {
      const outcome: HostKeyOutcome = {
        id: String(k.id),
        label: String(k.label ?? ""),
        ok: k.ok === true,
      };
      if (typeof k.error === "string") outcome.error = k.error;
      return outcome;
    });
  // An older API (no `complete`) read everything it could see: treat as complete.
  return { hosts, keys, complete: raw.complete !== false };
}

export function parseSyncRuns(json: unknown): SyncRun[] {
  const raw = isObj(json) ? json : {};
  return asArray(raw.runs)
    .filter(isObj)
    .map((r) => ({
      ...r,
      keyResults: Array.isArray(r.keyResults)
        ? (r.keyResults.filter(isObj).map((kr) => ({
            ...kr,
          })) as unknown as SyncRunKeyResult[])
        : null,
    })) as unknown as SyncRun[];
}
