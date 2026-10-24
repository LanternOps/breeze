/**
 * Publish outcome of a rule-set mutation (#6263 W04-3).
 *
 * Every rule mutation republishes in the same request and answers with W03's
 * `publish` body. A 2xx with `published: false` is an UNPUBLISHED edit, so the
 * editor must never toast "Saved" for it. `describePublishOutcome` is the
 * plan's table, evaluated top to bottom, first match wins:
 *
 * | # | condition                                   | tone    | key                |
 * | 1 | no `publish` key (metadata-only PATCH)      | success | saved              |
 * | 2 | autoQuarantineOnly                          | warning | autoQuarantineOnly |
 * | 3 | published && !stale && set.enabled          | success | published          |
 * |3b | published && !stale && !set.enabled         | success | savedDisabled      |
 * | 4 | precheckUnavailable                         | warning | checkerUnavailable |
 * | 5 | any errors[].ruleId                         | warning | compileErrors      |
 * | 6 | only ruleId:null errors                     | warning | setErrors          |
 * | 7 | !published, version 0, no errors            | warning | noEnabledRules     |
 *
 * Anything else (a malformed body, `published && stale` without the
 * auto-quarantine flag, a publish-carrying route that sent no `publish`) is
 * `unknown`: a warning, never a success.
 *
 * `publishSuccessMessage` is runAction's `successMessage`. It must NEVER throw:
 * runAction turns a throwing formatter into a generic "Done" success toast,
 * which is exactly the false "saved" this module exists to prevent.
 */
import { i18n } from '@/lib/i18n';
import type { YaraPublishBody } from './ruleSetsApi';

export type PublishTone = 'success' | 'warning';

export type PublishOutcomeKey =
  | 'saved'
  | 'autoQuarantineOnly'
  | 'published'
  | 'savedDisabled'
  | 'checkerUnavailable'
  | 'compileErrors'
  | 'setErrors'
  | 'noEnabledRules'
  | 'unknown';

export type DevicesKey = 'devicesKeep' | 'neverPublished' | 'setDisabled';

export interface RuleError {
  code: string;
  message: string;
  line?: number;
}

export interface PublishOutcome {
  tone: PublishTone;
  key: PublishOutcomeKey;
  /** Row 2 only: the row 4/5/6 reason, shown as a second line. */
  reasonKey?: 'checkerUnavailable' | 'compileErrors' | 'setErrors';
  params: {
    version?: number;
    count?: number;
    message?: string;
    devicesKey?: DevicesKey;
    devicesVersion?: number;
  };
  ruleErrors: Map<string, RuleError[]>;
  setErrors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The well-formed subset of a publish body, or null when it cannot be trusted. */
function parsePublish(p: unknown): YaraPublishBody | null {
  if (!isRecord(p)) return null;
  if (typeof p.published !== 'boolean' || typeof p.version !== 'number' || typeof p.stale !== 'boolean') return null;
  if (!Array.isArray(p.errors)) return null;
  const errors: YaraPublishBody['errors'] = [];
  for (const e of p.errors) {
    if (!isRecord(e) || typeof e.message !== 'string') continue;
    errors.push({
      ruleId: typeof e.ruleId === 'string' ? e.ruleId : null,
      name: typeof e.name === 'string' ? e.name : '',
      code: typeof e.code === 'string' ? e.code : 'error',
      message: e.message,
      ...(typeof e.line === 'number' ? { line: e.line } : {}),
    });
  }
  return {
    published: p.published,
    version: p.version,
    currentVersion: typeof p.currentVersion === 'number' ? p.currentVersion : p.version,
    stale: p.stale,
    errors,
    ...(p.autoQuarantineOnly === true ? { autoQuarantineOnly: true } : {}),
    ...(p.precheckUnavailable === true ? { precheckUnavailable: true } : {}),
  };
}

function devicesFor(version: number, enabled: boolean): Pick<PublishOutcome['params'], 'devicesKey' | 'devicesVersion'> {
  if (version === 0) return { devicesKey: 'neverPublished' };
  if (!enabled) return { devicesKey: 'setDisabled' };
  return { devicesKey: 'devicesKeep', devicesVersion: version };
}

export function describePublishOutcome(
  publish: YaraPublishBody | undefined,
  set: { enabled: boolean },
  opts: { expectPublish?: boolean } = {},
): PublishOutcome {
  const enabled = isRecord(set) ? set.enabled !== false : true;
  const empty = (): Pick<PublishOutcome, 'ruleErrors' | 'setErrors'> => ({ ruleErrors: new Map(), setErrors: [] });

  if (publish === undefined && !opts.expectPublish) {
    return { tone: 'success', key: 'saved', params: {}, ...empty() };
  }
  const p = parsePublish(publish);
  if (!p) return { tone: 'warning', key: 'unknown', params: {}, ...empty() };

  const ruleErrors = new Map<string, RuleError[]>();
  const setErrors: string[] = [];
  for (const e of p.errors) {
    if (e.ruleId) {
      const list = ruleErrors.get(e.ruleId) ?? [];
      list.push({ code: e.code, message: e.message, ...(e.line !== undefined ? { line: e.line } : {}) });
      ruleErrors.set(e.ruleId, list);
    } else {
      setErrors.push(e.message);
    }
  }
  const devices = devicesFor(p.version, enabled);

  // The row 4/5/6 reason, shared by rows 2 and 4–6.
  const reason = ((): { key: 'checkerUnavailable' | 'compileErrors' | 'setErrors'; params: PublishOutcome['params'] } | null => {
    if (p.precheckUnavailable) return { key: 'checkerUnavailable', params: { ...devices } };
    if (ruleErrors.size > 0) return { key: 'compileErrors', params: { count: ruleErrors.size, ...devices } };
    if (setErrors.length > 0) return { key: 'setErrors', params: { message: setErrors.join('; '), ...devices } };
    return null;
  })();

  // Row 2.
  if (p.autoQuarantineOnly) {
    return {
      tone: 'warning',
      key: 'autoQuarantineOnly',
      ...(reason ? { reasonKey: reason.key } : {}),
      params: { ...(reason?.params ?? {}), version: p.version },
      ruleErrors,
      setErrors,
    };
  }
  // Rows 3 / 3b.
  if (p.published && !p.stale) {
    return {
      tone: 'success',
      key: enabled ? 'published' : 'savedDisabled',
      params: { version: p.version },
      ruleErrors: new Map(),
      setErrors: [],
    };
  }
  // Rows 4–6.
  if (reason) return { tone: 'warning', key: reason.key, params: reason.params, ruleErrors, setErrors };
  // Row 7.
  if (!p.published && p.version === 0) {
    return { tone: 'warning', key: 'noEnabledRules', params: {}, ruleErrors, setErrors };
  }
  return { tone: 'warning', key: 'unknown', params: { ...devices }, ruleErrors, setErrors };
}

const NS = 'security:detectionRules.publish';

function devicesText(params: PublishOutcome['params']): string {
  if (!params.devicesKey) return '';
  return i18n.t(/* i18n-dynamic */ `${NS}.${params.devicesKey}`, { version: params.devicesVersion ?? 0 });
}

/** Translated copy for an outcome: `message`, plus `detail` for row 2's reason. */
export function formatPublishOutcome(o: PublishOutcome): { message: string; detail?: string } {
  const devices = devicesText(o.params);
  const params = { ...o.params, devices };
  const message = i18n.t(/* i18n-dynamic */ `${NS}.${o.key}`, params);
  if (o.reasonKey) return { message, detail: i18n.t(/* i18n-dynamic */ `${NS}.${o.reasonKey}`, params) };
  return { message };
}

/** Persistent banner for a set the server reports as `stale` (GET), e.g. after a reload. */
export function staleBannerText(set: { publishedVersion: number; enabled: boolean }): string {
  return i18n.t(/* i18n-dynamic */ `${NS}.staleBanner`, { devices: devicesText(devicesFor(set.publishedVersion, set.enabled)) });
}

/**
 * runAction `successMessage` for publish-carrying mutations (rule create /
 * update / delete, IOC import): the success copy for rows 3/3b, '' (no toast)
 * for everything else. Never throws.
 */
export function publishSuccessMessage(body: unknown, set: { enabled: boolean }): string {
  try {
    if (!isRecord(body)) return '';
    const o = describePublishOutcome(body.publish as YaraPublishBody | undefined, set, { expectPublish: true });
    return o.tone === 'success' ? formatPublishOutcome(o).message : '';
  } catch (err) {
    // Never throw: runAction would turn that into a generic "Done" success toast.
    console.error('[publishOutcome] success formatter failed; no success toast', err);
    return '';
  }
}

/**
 * runAction `successMessage` for a rule-set PATCH, where `publish` is present
 * only when enabled/autoQuarantine changed on a published set. Reads the set's
 * new `enabled` from the response. Never throws.
 */
export function ruleSetPatchSuccessMessage(body: unknown): string {
  try {
    if (!isRecord(body)) return '';
    const data = isRecord(body.data) ? body.data : {};
    const enabled = data.enabled !== false;
    const o = describePublishOutcome(body.publish as YaraPublishBody | undefined, { enabled });
    return o.tone === 'success' ? formatPublishOutcome(o).message : '';
  } catch (err) {
    // Never throw: runAction would turn that into a generic "Done" success toast.
    console.error('[publishOutcome] success formatter failed; no success toast', err);
    return '';
  }
}
