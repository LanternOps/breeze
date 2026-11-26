/**
 * Selects the format a verified file-index hydration publishes for snapshot
 * file index checkpoint+delta (#11736).
 *
 * `off` is the default and publishes today's full rows. `canary` publishes
 * deltas only for the orgs listed in BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS, and
 * `on` publishes deltas for every org. The reader understands both formats
 * always, so turning this off never strands a delta snapshot.
 *
 * The environment is read on every call (nothing is cached), so an operator
 * change takes effect without a restart of the logic; the env itself is read
 * at process level.
 */

export type DeltaPublishSetting = 'off' | 'canary' | 'on';

export const BACKUP_INDEX_DELTA_PUBLISH_ENV = 'BACKUP_INDEX_DELTA_PUBLISH';
export const BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS_ENV = 'BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOGGED_VALUE = 64;

const warnedSettingValues = new Set<string>();
const warnedOrgItems = new Set<string>();

function describeValue(raw: string): string {
  return JSON.stringify(raw.slice(0, MAX_LOGGED_VALUE));
}

/** Reads process.env on every call (no caching of the value). */
export function resolveDeltaPublishSetting(env: NodeJS.ProcessEnv = process.env): DeltaPublishSetting {
  const raw = env[BACKUP_INDEX_DELTA_PUBLISH_ENV];
  if (raw === undefined) return 'off';
  const value = raw.trim().toLowerCase();
  if (value === '') return 'off';
  if (value === 'off' || value === 'canary' || value === 'on') return value;

  if (!warnedSettingValues.has(raw)) {
    warnedSettingValues.add(raw);
    console.warn(
      `[backup-index] ${BACKUP_INDEX_DELTA_PUBLISH_ENV}=${describeValue(raw)} is not one of off, canary, on; treating it as off`,
    );
  }
  return 'off';
}

function listedOrgIds(env: NodeJS.ProcessEnv): Set<string> {
  const ids = new Set<string>();
  const raw = env[BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS_ENV];
  if (!raw) return ids;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    if (!UUID_RE.test(item)) {
      if (!warnedOrgItems.has(item)) {
        warnedOrgItems.add(item);
        console.warn(
          `[backup-index] ${BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS_ENV} entry ${describeValue(item)} is not a UUID; ignoring it`,
        );
      }
      continue;
    }
    ids.add(item.toLowerCase());
  }
  return ids;
}

/** 'delta' when the setting is 'on', or 'canary' and orgId is listed; otherwise 'rows'. */
export function resolveDeltaPublishMode(
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): 'rows' | 'delta' {
  const setting = resolveDeltaPublishSetting(env);
  if (setting === 'on') return 'delta';
  if (setting === 'canary' && listedOrgIds(env).has(orgId.toLowerCase())) return 'delta';
  return 'rows';
}

/** Test-only: forget which values have already been warned about. */
export function resetDeltaPublishFlagWarningsForTests(): void {
  warnedSettingValues.clear();
  warnedOrgItems.clear();
}
