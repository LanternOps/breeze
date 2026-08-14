import type { WorkspaceDatabase } from '../hostTypes';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { workspaceOrgSettings } from '../schema/orgSettings';

export type DlpAction = 'block' | 'redact' | 'log' | 'off';
export type DetectorId = 'credit_card' | 'iban' | 'ssn' | 'api_key' | 'email' | 'phone';

export interface DlpConfig {
  detectors: Record<DetectorId, DlpAction>;
  customPatterns: Array<{ name: string; pattern: string; action: DlpAction }>;
}

export interface OrgSettings {
  contentEnabled: boolean;
  dlpConfig: DlpConfig;
}

const ACTIONS: DlpAction[] = ['block', 'redact', 'log', 'off'];

// Mirrors client-ai defaults (apps/api/src/services/clientAiDlp.ts): financial
// and credential detectors default to redact; contact detectors default off.
//
// Frozen (including the nested `detectors` object) so that any accidental
// in-place mutation by a caller — e.g. a future DLP-enforcement task doing
// `settings.dlpConfig.detectors[id] = override` — throws immediately in
// strict mode rather than silently corrupting this shared, process-wide
// default for every org that has no settings row. Callers should still
// treat this as logically read-only and prefer a fresh copy (see
// `normalizeDlp(undefined)`, used by `getOrgSettings`'s no-row branch)
// rather than relying on the freeze alone.
export const DEFAULT_DLP_CONFIG: DlpConfig = Object.freeze({
  detectors: Object.freeze({
    credit_card: 'redact',
    iban: 'redact',
    ssn: 'redact',
    api_key: 'redact',
    email: 'off',
    phone: 'off',
  }),
  customPatterns: [],
}) as DlpConfig;

/**
 * Default-deny normalization: any missing, unknown, or malformed piece of a
 * stored DLP config collapses to the safe default rather than being trusted
 * as-is. This is the one place downstream DLP enforcement may assume a fully
 * valid DlpConfig shape.
 */
function normalizeDlp(raw: unknown): DlpConfig {
  const rawObj = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
  const rawDetectors = (rawObj.detectors && typeof rawObj.detectors === 'object'
    ? rawObj.detectors as Record<string, unknown>
    : {});

  const detectors = {} as Record<DetectorId, DlpAction>;
  for (const key of Object.keys(DEFAULT_DLP_CONFIG.detectors) as DetectorId[]) {
    const candidate = rawDetectors[key];
    detectors[key] = (typeof candidate === 'string' && ACTIONS.includes(candidate as DlpAction))
      ? candidate as DlpAction
      : DEFAULT_DLP_CONFIG.detectors[key];
  }

  const rawPatterns = Array.isArray(rawObj.customPatterns) ? rawObj.customPatterns : [];
  const customPatterns: DlpConfig['customPatterns'] = [];
  for (const entry of rawPatterns) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, pattern, action } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof pattern !== 'string') continue;
    if (typeof action !== 'string' || !ACTIONS.includes(action as DlpAction)) continue;
    try {
      void new RegExp(pattern); // validity check only, the RegExp itself is discarded
    } catch {
      continue; // malformed pattern: drop the entry rather than trust it
    }
    customPatterns.push({ name, pattern, action: action as DlpAction });
  }

  return { detectors, customPatterns };
}

export async function getOrgSettings(db: WorkspaceDatabase, orgId: string): Promise<OrgSettings> {
  const d = db;
  const rows = await d.select().from(workspaceOrgSettings).where(eq(workspaceOrgSettings.orgId, orgId));
  // normalizeDlp(undefined) builds a fresh, independent DlpConfig (equal in
  // value to DEFAULT_DLP_CONFIG but not the same reference), so callers can
  // never mutate the shared module-level singleton via this path.
  if (rows.length === 0) return { contentEnabled: false, dlpConfig: normalizeDlp(undefined) };
  const raw = rows[0] as { contentEnabled?: unknown; dlpConfig?: unknown };
  return {
    contentEnabled: raw.contentEnabled === true,
    dlpConfig: normalizeDlp(raw.dlpConfig),
  };
}

export async function putOrgSettings(
  db: WorkspaceDatabase,
  orgId: string,
  patch: { contentEnabled?: boolean; dlpConfig?: DlpConfig },
): Promise<OrgSettings> {
  const d = db;
  const contentEnabled = patch.contentEnabled ?? false;
  // The dlpConfig column is typed as a generic jsonb bag; DlpConfig is a
  // plain JSON-shaped object, so this cast is a widening, not an unsafe one.
  const dlpConfig = normalizeDlp(patch.dlpConfig) as unknown as Record<string, unknown>;

  await d.insert(workspaceOrgSettings)
    .values({ orgId, contentEnabled, dlpConfig, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: workspaceOrgSettings.orgId,
      set: {
        // Partial patches leave the unspecified field untouched — only
        // overwrite what the caller actually provided.
        ...(patch.contentEnabled !== undefined ? { contentEnabled: patch.contentEnabled } : {}),
        ...(patch.dlpConfig !== undefined ? { dlpConfig } : {}),
        updatedAt: sql`now()`,
      },
    });

  return getOrgSettings(db, orgId);
}
