import { CONNECTION_REGISTRY } from './registry';
import { isFlagOn, isSet } from './statusHelpers';
import {
  CONNECTION_GROUPS,
  CONNECTION_STATUSES,
  type ConnectionEntry,
  type ConnectionStatus,
  type ConnectionsReport,
  type ConnectionsReportEntry,
  type ConnectionsReportVar,
  type EnvSnapshot,
} from './types';

/** `scheme://user:pass@host` — URL userinfo (spec invariant 2, value-shape guard). */
const URL_USERINFO = /:\/\/[^/?#\s]*@/;
/** `scheme://host/path?query` — gateways and DSNs carry keys in the query (cf. CSP_REPORT_URI). */
const URL_QUERY = /^[a-z][a-z0-9+.-]*:\/\/[^?#\s]*\?/i;
/** Service-account JSON or PEM key material pasted into a non-secret var. */
const KEY_MATERIAL = /private_key|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

/**
 * Returns the value to display for a `secret: false` var, or undefined when
 * the value must not be shown. A refused value still renders as `set`.
 */
export function displayableValue(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (URL_USERINFO.test(value) || URL_QUERY.test(value) || KEY_MATERIAL.test(value)) return undefined;
  return value;
}

function reportVar(env: EnvSnapshot, v: ConnectionEntry['vars'][number]): ConnectionsReportVar {
  const set = isSet(env, v.name);
  if (v.secret !== false) return { name: v.name, secret: true, set };
  const value = displayableValue(env[v.name]);
  return value === undefined ? { name: v.name, secret: false, set } : { name: v.name, secret: false, set, value };
}

function reportEntry(env: EnvSnapshot, entry: ConnectionEntry): ConnectionsReportEntry {
  const { status, reason } = entry.status(env);
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    status,
    ...(reason ? { reason } : {}),
    vars: entry.vars.map((v) => reportVar(env, v)),
  };
}

/**
 * Pure: env snapshot in, report out. The only place that reads env values for
 * display; it never logs them (spec §2). No DB, no network, no file reads.
 */
export function buildConnectionsReport(
  env: EnvSnapshot,
  registry: readonly ConnectionEntry[] = CONNECTION_REGISTRY,
): ConnectionsReport {
  const summary = Object.fromEntries(CONNECTION_STATUSES.map((s) => [s, 0])) as Record<ConnectionStatus, number>;
  const groups: ConnectionsReport['groups'] = [];

  for (const group of CONNECTION_GROUPS) {
    const entries = registry.filter((e) => e.group === group).map((e) => reportEntry(env, e));
    if (entries.length === 0) continue;
    for (const entry of entries) summary[entry.status] += 1;
    groups.push({ group, entries });
  }

  return {
    version: env.APP_VERSION?.trim() || 'unknown',
    deployMode: isFlagOn(env, 'IS_HOSTED') ? 'hosted' : 'self_host',
    scope: 'api',
    summary,
    groups,
  };
}
