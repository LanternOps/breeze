// Wisp W08 (feature #9906): where the "Link an item to Wisp" picker finds
// candidates. Each kind reads the list endpoint its own page already uses —
// there is deliberately no cross-entity search route, so the picker can never
// see more than the caller's normal list permissions allow. The server
// re-resolves label, status and org from the entity on add, so the mapping
// here only has to be good enough to choose by.
import { WISP_LINK_LABEL_MAX, type WispEntityKind } from '@breeze/shared';

export type PickerRow = { kind: WispEntityKind; id: string; orgId: string | null; label: string; status: string | null };

export type EntitySource = {
  kind: WispEntityKind;
  listUrl: (search: string) => string;
  /** True when the endpoint filters by `search`; otherwise the picker filters client-side. */
  serverSearch: boolean;
  /** Throws on a body without a `data` array — a contract break must not read as "no matches". */
  rows: (body: unknown) => PickerRow[];
};

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function source(
  kind: WispEntityKind,
  base: string,
  serverSearch: boolean,
  map: (r: Raw, id: string) => { label: string | null; status: string | null; orgId: string | null },
): EntitySource {
  return {
    kind,
    serverSearch,
    listUrl: (search) => {
      const q = search.trim();
      return serverSearch && q ? `${base}&search=${encodeURIComponent(q)}` : base;
    },
    rows: (body) => {
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) throw new Error(`${kind} list: response has no data array`);
      const out: PickerRow[] = [];
      for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Raw;
        if (typeof r.id !== 'string' || r.id === '') continue;
        const m = map(r, r.id);
        out.push({ kind, id: r.id, orgId: m.orgId, label: (m.label ?? r.id).slice(0, WISP_LINK_LABEL_MAX), status: m.status });
      }
      return out;
    },
  };
}

const orgOf = (r: Raw) => str(r.orgId);
const joined = (a: string | null, sep: string, b: string | null) => (a && b ? `${a}${sep}${b}` : a ?? b);

export const WISP_ENTITY_SOURCES: Record<WispEntityKind, EntitySource> = {
  ticket: source('ticket', '/tickets?limit=25', true, (r) => {
    const n = typeof r.internalNumber === 'number' || str(r.internalNumber) ? `#${String(r.internalNumber).trim()}` : null;
    return { label: joined(n, ' ', str(r.subject)), status: str(r.status), orgId: orgOf(r) };
  }),
  quote: source('quote', '/quotes?limit=50', false, (r) => ({
    label: joined(str(r.quoteNumber), ' ', str(r.title)), status: str(r.status), orgId: orgOf(r),
  })),
  invoice: source('invoice', '/invoices?limit=50', false, (r) => ({
    label: str(r.invoiceNumber), status: str(r.status), orgId: orgOf(r),
  })),
  contract: source('contract', '/contracts?limit=50', false, (r) => ({
    label: str(r.name), status: str(r.status), orgId: orgOf(r),
  })),
  device: source('device', '/devices?limit=25', true, (r) => ({
    label: str(r.displayName) ?? str(r.hostname), status: str(r.status), orgId: orgOf(r),
  })),
  // An organization is its own org: the add route resolves it by id.
  organization: source('organization', '/orgs/organizations?limit=25', true, (r, id) => ({
    label: str(r.name), status: str(r.status), orgId: id,
  })),
  site: source('site', '/orgs/sites?limit=50', false, (r) => ({ label: str(r.name), status: null, orgId: orgOf(r) })),
  alert: source('alert', '/alerts?limit=50', false, (r) => ({ label: str(r.title), status: str(r.status), orgId: orgOf(r) })),
  run: source('run', '/ai/agents/runs?limit=50', false, (r) => ({
    // A run without an agent name is still linkable; its id is the label of last resort.
    label: str(r.agentName) ? joined(str(r.agentName), ' — ', str(r.summaryExcerpt)) : null,
    status: str(r.status),
    orgId: orgOf(r),
  })),
  task: source('task', '/ai/operator/tasks?limit=50', false, (r) => {
    const target = r.target && typeof r.target === 'object' ? (r.target as Raw) : null;
    return { label: str(r.objective) ?? str(target?.label), status: str(r.state), orgId: orgOf(r) };
  }),
  // Users are partner-level: the link carries no org (PARTNER_LEVEL_ENTITY_KINDS).
  user: source('user', '/users', false, (r) => {
    const email = str(r.email);
    return { label: str(r.name) ? joined(str(r.name), ' ', email ? `<${email}>` : null) : email, status: str(r.status), orgId: null };
  }),
};

export function filterRows(rows: PickerRow[], search: string): PickerRow[] {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.label.toLowerCase().includes(q));
}

export const linkKey = (kind: WispEntityKind, id: string) => `${kind}:${id}`;
