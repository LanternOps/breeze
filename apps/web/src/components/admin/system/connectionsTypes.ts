/**
 * Web-side contract for GET /api/v1/admin/system/connections (W01).
 * Mirrors `ConnectionsReport` in apps/api/src/system/connections/types.ts
 * field for field (spec §2,
 * docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md).
 * The route wraps it as `{ data: ConnectionsReport }`, like every admin route.
 */

export type ConnectionStatus = 'enabled' | 'disabled' | 'misconfigured' | 'required_missing';

/** Display order for the summary strip. */
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'enabled',
  'disabled',
  'misconfigured',
  'required_missing',
];

export interface ConnectionVarView {
  name: string;
  secret: boolean;
  set: boolean;
  /** Only ever populated by the API for `secret: false` vars. The web re-checks anyway. */
  value?: string;
}

export interface ConnectionEntryView {
  id: string;
  label: string;
  /** A docs-site path such as `/deploy/environment/#database` (W01 registry). */
  docsUrl?: string;
  status: ConnectionStatus;
  /** Names vars, never values (spec invariant 4). English, rendered as sent. */
  reason?: string;
  vars: ConnectionVarView[];
}

export interface ConnectionGroupView {
  /**
   * A W01 `ConnectionGroup` id, e.g. `core`, `email`, `storage-backups`.
   * Typed as string (not the W01 union) so an id added by a newer API still
   * renders, falling back to the raw id as its heading.
   */
  group: string;
  entries: ConnectionEntryView[];
}

export interface ConnectionsReport {
  version: string;
  deployMode: 'hosted' | 'self_host';
  scope: 'api';
  summary: Record<ConnectionStatus, number>;
  groups: ConnectionGroupView[];
}

export function isProblemStatus(status: ConnectionStatus): boolean {
  return status === 'misconfigured' || status === 'required_missing';
}

// Same shape as the builder's runtime refusal (spec invariant 2): a value
// carrying URL userinfo is a credential, whatever the registry says.
const URL_USERINFO = /:\/\/[^/?#\s]*@/;

/**
 * D2/D8 on the client: the value is shown only when the API marked the var
 * `secret: false` (strict), the var is set, and the value is non-empty with
 * no URL userinfo. Every other case renders the set/not-set pill. This is
 * defense in depth — the API should never send `value` for a secret var.
 */
export function displayableValue(v: ConnectionVarView): string | null {
  if (v.secret !== false || v.set !== true) return null;
  if (typeof v.value !== 'string' || v.value.length === 0) return null;
  if (URL_USERINFO.test(v.value)) return null;
  return v.value;
}

export function filterGroups(groups: ConnectionGroupView[], problemsOnly: boolean): ConnectionGroupView[] {
  return groups
    .map((g) => (problemsOnly ? { ...g, entries: g.entries.filter((e) => isProblemStatus(e.status)) } : g))
    .filter((g) => g.entries.length > 0);
}

/** Public docs site that W01's registry paths are relative to. */
export const DOCS_ORIGIN = 'https://docs.breezermm.com';

/**
 * W01 sends docs-site paths (`/deploy/environment/#database`); they resolve
 * against DOCS_ORIGIN and must stay on it. Absolute https URLs are accepted
 * as-is. Anything else (protocol-relative `//host`, `/\host`, un-rooted
 * paths, http, javascript:) is dropped, so no docs link renders.
 */
export function safeDocsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    if (url.startsWith('/')) {
      const resolved = new URL(url, DOCS_ORIGIN);
      return resolved.origin === DOCS_ORIGIN ? resolved.toString() : null;
    }
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
