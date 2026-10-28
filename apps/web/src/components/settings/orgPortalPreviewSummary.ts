import type { TFunction } from 'i18next';
import type { DashboardTileKey, SecurityScoreBand, TileStatus } from '@breeze/shared';
import { formatDate } from '@/lib/dateTimeFormat';

/**
 * Compact "label: value" rows for one section of the staff Customer view
 * (#9350). Labels mirror the wording the customer portal itself uses
 * (apps/portal DashboardTiles) so staff read the same register the customer
 * does — never a DTO field name (#9952).
 */
export type PreviewRow = { label: string; value: string };

type Translate = TFunction;

/**
 * Label of every dashboard tile. Keyed by DashboardTileKey, so a tile added to
 * DashboardDto fails typecheck here until it has a label; the API's preview
 * allowlist is typed to the same key set.
 */
export const DASHBOARD_TILE_LABEL_KEYS: Record<DashboardTileKey, string> = {
  awaitingYou: 'settings:orgPortalSettingsEditor.preview.tiles.awaitingYou',
  devicesProtected: 'settings:orgPortalSettingsEditor.preview.tiles.devicesProtected',
  securityScore: 'settings:orgPortalSettingsEditor.preview.tiles.securityScore',
  actionItems: 'settings:orgPortalSettingsEditor.preview.tiles.actionItems',
  patchesApplied: 'settings:orgPortalSettingsEditor.preview.tiles.patchesApplied',
  backup: 'settings:orgPortalSettingsEditor.preview.tiles.backup',
  service: 'settings:orgPortalSettingsEditor.preview.tiles.service',
  support: 'settings:orgPortalSettingsEditor.preview.tiles.support',
};

/** What the portal says when a figure is not there (portal UNAVAILABLE copy). */
const TILE_STATUS_KEYS: Record<Exclude<TileStatus, 'ok'>, string> = {
  no_data: 'settings:orgPortalSettingsEditor.preview.tileStatus.noData',
  not_configured: 'settings:orgPortalSettingsEditor.preview.tileStatus.notConfigured',
  stale: 'settings:orgPortalSettingsEditor.preview.tileStatus.stale',
};

const SCORE_BAND_KEYS: Record<SecurityScoreBand, string> = {
  strong: 'settings:orgPortalSettingsEditor.preview.bands.strong',
  good: 'settings:orgPortalSettingsEditor.preview.bands.good',
  fair: 'settings:orgPortalSettingsEditor.preview.bands.fair',
  at_risk: 'settings:orgPortalSettingsEditor.preview.bands.at_risk',
};

/** Every looked-up (non-literal) key this module renders, for the locale coverage test. */
export const PREVIEW_SUMMARY_KEYS: readonly string[] = [
  ...Object.values(DASHBOARD_TILE_LABEL_KEYS),
  ...Object.values(TILE_STATUS_KEYS),
  ...Object.values(SCORE_BAND_KEYS),
].map((k) => k.replace(/^settings:/, ''));

type Obj = Record<string, unknown>;

const isRecord = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function statusLabel(t: Translate, status: unknown): string {
  const key = TILE_STATUS_KEYS[status as Exclude<TileStatus, 'ok'>] ?? TILE_STATUS_KEYS.no_data;
  return t(/* i18n-dynamic */ key);
}

/**
 * The portal's rule: an `ok` tile without a figure reads "Not yet available";
 * a stale figure is still shown, marked as possibly out of date; any other
 * non-ok status replaces the figure with its plain-language label.
 */
function withStatus(t: Translate, status: unknown, value: string | null): string {
  if (value !== null && status === 'ok') return value;
  if (value !== null && status === 'stale') return `${value} · ${statusLabel(t, 'stale')}`;
  return statusLabel(t, status === 'ok' ? 'no_data' : status);
}

function scoreValue(t: Translate, score: unknown, band: unknown): string | null {
  const s = num(score);
  if (s === null) return null;
  const bandKey = SCORE_BAND_KEYS[band as SecurityScoreBand];
  return bandKey ? `${s} (${t(/* i18n-dynamic */ bandKey)})` : String(s);
}

function protectedOfTotal(t: Translate, prot: unknown, total: unknown): string | null {
  const p = num(prot);
  const n = num(total);
  return p === null || n === null
    ? null
    : t('settings:orgPortalSettingsEditor.preview.values.protectedOfTotal', { protected: p, total: n });
}

const dateValue = (v: unknown): string | null => {
  const s = str(v);
  return s ? formatDate(s, { dateStyle: 'medium' }) : null;
};

const TILE_VALUE: Record<DashboardTileKey, (tile: Obj, t: Translate) => string | null> = {
  awaitingYou: (tile, t) => {
    const proposals = num(tile.proposals);
    const invoices = num(tile.invoices);
    return proposals === null || invoices === null
      ? null
      : t('settings:orgPortalSettingsEditor.preview.values.awaitingCounts', { proposals, invoices });
  },
  devicesProtected: (tile, t) => protectedOfTotal(t, tile.protected, tile.total),
  securityScore: (tile, t) => scoreValue(t, tile.score, tile.band),
  actionItems: (tile) => (num(tile.count) === null ? null : String(tile.count)),
  patchesApplied: (tile) => (num(tile.applied) === null ? null : String(tile.applied)),
  backup: (tile) => dateValue(tile.completedAt),
  service: (tile, t) => {
    const onTime = num(tile.deliveredOnTime);
    if (onTime !== null) {
      return t('settings:orgPortalSettingsEditor.preview.values.serviceCounts', {
        onTime,
        late: num(tile.deliveredLate) ?? 0,
        missed: num(tile.missed) ?? 0,
      });
    }
    const next = isRecord(tile.nextDue) ? tile.nextDue : null;
    const name = next ? str(next.name) : null;
    const due = next ? dateValue(next.dueAt) : null;
    return name && due ? t('settings:orgPortalSettingsEditor.preview.values.nextDue', { name, date: due }) : null;
  },
  support: (tile, t) => {
    const count = num(tile.openTickets);
    return count === null ? null : t('settings:orgPortalSettingsEditor.preview.values.openRequests', { count });
  },
};

function summarizeDashboard(data: Obj, t: Translate): PreviewRow[] {
  const rows: PreviewRow[] = [];
  // Portal ledger order; keys the API did not send (withheld tiles) are skipped.
  for (const key of Object.keys(DASHBOARD_TILE_LABEL_KEYS) as DashboardTileKey[]) {
    const tile = data[key];
    if (!isRecord(tile)) continue;
    rows.push({
      label: t(/* i18n-dynamic */ DASHBOARD_TILE_LABEL_KEYS[key]),
      value: withStatus(t, tile.status, TILE_VALUE[key](tile, t)),
    });
  }
  return rows;
}

function summarizeSecurity(data: Obj, t: Translate): PreviewRow[] {
  const rows: PreviewRow[] = [{
    label: t(/* i18n-dynamic */ DASHBOARD_TILE_LABEL_KEYS.securityScore),
    value: withStatus(t, data.dataStatus, scoreValue(t, data.score, data.band)),
  }];
  const vulns = isRecord(data.vulnerabilities) ? data.vulnerabilities : null;
  if (vulns) {
    const bySeverity = isRecord(vulns.openBySeverity) ? Object.values(vulns.openBySeverity) : [];
    const open = bySeverity.reduce<number>((sum, n) => sum + (num(n) ?? 0), 0);
    rows.push({ label: t('settings:orgPortalSettingsEditor.preview.securityRows.openVulnerabilities'), value: String(open) });
    const kev = num(vulns.kevCount);
    if (kev !== null) {
      rows.push({ label: t('settings:orgPortalSettingsEditor.preview.securityRows.knownExploited'), value: String(kev) });
    }
  }
  const threats = isRecord(data.threatEvents) && Array.isArray(data.threatEvents.weeks) ? data.threatEvents.weeks : null;
  if (threats) {
    const total = (field: 'detected' | 'resolved') =>
      threats.reduce<number>((sum, w) => sum + (isRecord(w) ? num(w[field]) ?? 0 : 0), 0);
    rows.push({
      label: t('settings:orgPortalSettingsEditor.preview.securityRows.threatEvents'),
      value: t('settings:orgPortalSettingsEditor.preview.values.threatCounts', {
        detected: total('detected'),
        resolved: total('resolved'),
      }),
    });
  }
  return rows;
}

function summarizeBackups(data: Obj, t: Translate): PreviewRow[] {
  const rows: PreviewRow[] = [{
    label: t('settings:orgPortalSettingsEditor.preview.backupRows.devices'),
    value: withStatus(t, data.dataStatus, protectedOfTotal(t, data.protected, data.total)),
  }];
  const verified = isRecord(data.lastPassedVerification) ? dateValue(data.lastPassedVerification.completedAt) : null;
  rows.push({
    label: t(/* i18n-dynamic */ DASHBOARD_TILE_LABEL_KEYS.backup),
    value: verified ?? statusLabel(t, 'no_data'),
  });
  const rpo = num(data.openRpoBreaches);
  const rto = num(data.openRtoBreaches);
  if (rpo !== null || rto !== null) {
    rows.push({
      label: t('settings:orgPortalSettingsEditor.preview.backupRows.breaches'),
      // RPO/RTO are industry acronyms, identical in every locale.
      value: `RPO ${rpo ?? 0} · RTO ${rto ?? 0}`,
    });
  }
  const providers = Array.isArray(data.externalProviders)
    ? data.externalProviders.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  if (providers.length > 0) {
    rows.push({ label: t('settings:orgPortalSettingsEditor.preview.backupRows.providers'), value: providers.join(', ') });
  }
  return rows;
}

function summarizeList(key: string, data: Obj): PreviewRow[] {
  if (key === 'documents') {
    return (Array.isArray(data.groups) ? data.groups : []).flatMap((g: any) =>
      (g.documents ?? []).filter((d: any) => d?.title).map((d: any) => ({ label: String(d.title), value: String(g.category ?? '') })));
  }
  if (key === 'service') {
    return (Array.isArray(data.groups) ? data.groups : []).flatMap((g: any) =>
      (g.deliverables ?? []).filter((d: any) => d?.name).map((d: any) => ({ label: String(d.name), value: String(d.status ?? '') })));
  }
  return (Array.isArray(data.data) ? data.data : []).filter((r: any) => r?.name).map((r: any) => ({
    label: String(r.name), value: String(r.status ?? ''),
  }));
}

/**
 * Rows for one section's payload. A section with no summarizer here renders no
 * rows rather than falling back to raw DTO field names: wiring a new preview
 * read model (#9750) must add its summarizer.
 */
export function summarizeSection(key: string, data: unknown, t: Translate): PreviewRow[] {
  if (!isRecord(data)) return [];
  switch (key) {
    case 'dashboard': return summarizeDashboard(data, t);
    case 'security': return summarizeSecurity(data, t);
    case 'backups': return summarizeBackups(data, t);
    case 'documents':
    case 'service':
    case 'reports': return summarizeList(key, data);
    default: return [];
  }
}
