import { describe, it, expect } from 'vitest';
import { MONITOR_KINDS, monitorConditionSchemas, type MonitorKind } from '@breeze/shared';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONITOR_KIND_FIELDS, defaultConditionFor } from './monitorKindFields';
import { SELECT_OPTION_NAMESPACE } from './MonitorConditionFields';

/**
 * `.refine()`d schemas (five of the W04 kinds — antivirus, software_presence,
 * backup_continuity, network_check) don't necessarily keep `.shape` reachable
 * the same way a plain `z.object()` does across zod versions/refine
 * implementations, so unwrap defensively instead of assuming a bare
 * `.shape` access always works: `.shape` first (verified by experiment
 * against this repo's installed zod to still be a plain accessor on a
 * refined `ZodObject` here — refinements land in `_def.checks`, not a
 * wrapping `ZodEffects`/`ZodPipe`), then fall back to walking a wrapper's
 * inner schema (`_def`/`def` . `innerType`/`schema`) for any zod shape where
 * refining an object DOES wrap it.
 */
function unwrapShape(schema: unknown): Record<string, unknown> {
  const candidate = schema as {
    shape?: Record<string, unknown>;
    _def?: { innerType?: unknown; schema?: unknown };
    def?: { innerType?: unknown; schema?: unknown };
  };
  if (candidate.shape) return candidate.shape;
  const def = candidate._def ?? candidate.def;
  const inner = def?.innerType ?? def?.schema;
  if (inner) return unwrapShape(inner);
  throw new Error('unwrapShape: could not find a zod object shape on this schema');
}

describe('monitorKindFields (#5289, #5291)', () => {
  it('has a field-map entry for every monitor kind', () => {
    for (const kind of MONITOR_KINDS) {
      expect(MONITOR_KIND_FIELDS[kind]).toBeDefined();
      expect(MONITOR_KIND_FIELDS[kind].length).toBeGreaterThan(0);
    }
  });

  it('every field key is a key of the kind\'s condition schema shape', () => {
    for (const kind of MONITOR_KINDS) {
      const shape = unwrapShape(monitorConditionSchemas[kind as MonitorKind]);
      for (const field of MONITOR_KIND_FIELDS[kind as MonitorKind]) {
        expect(Object.keys(shape)).toContain(field.key);
      }
    }
  });

  it('defaultConditionFor produces a value that validates against the kind schema', () => {
    for (const kind of MONITOR_KINDS) {
      const result = monitorConditionSchemas[kind as MonitorKind].safeParse(defaultConditionFor(kind as MonitorKind));
      expect({ kind, success: result.success, error: result.success ? undefined : result.error.message }).toEqual(
        expect.objectContaining({ success: true }),
      );
    }
  });

  describe('W04 kinds (#5291)', () => {
    const w04Kinds = ['antivirus', 'software_presence', 'backup_continuity', 'script', 'network_check'] as const;

    it.each(w04Kinds)('%s default condition validates', (kind) => {
      const result = monitorConditionSchemas[kind].safeParse(defaultConditionFor(kind));
      expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    });

    it('antivirus conditional fields carry the expected showWhen', () => {
      const fields = MONITOR_KIND_FIELDS.antivirus;
      const staleAfterDays = fields.find((f) => f.key === 'staleAfterDays');
      const minThreatCount = fields.find((f) => f.key === 'minThreatCount');
      expect(staleAfterDays?.showWhen).toEqual({ key: 'check', equals: 'definitions_stale' });
      expect(minThreatCount?.showWhen).toEqual({ key: 'check', equals: 'threats_present' });
    });

    it('network_check conditional fields carry the expected showWhen', () => {
      const fields = MONITOR_KIND_FIELDS.network_check;
      const port = fields.find((f) => f.key === 'port');
      const expectStatus = fields.find((f) => f.key === 'expectStatus');
      expect(port?.showWhen).toEqual({ key: 'checkType', equals: 'tcp_port' });
      expect(expectStatus?.showWhen).toEqual({ key: 'checkType', equals: 'http_check' });
    });

    it('software_presence version field carries the expected showWhen', () => {
      const version = MONITOR_KIND_FIELDS.software_presence.find((f) => f.key === 'version');
      expect(version?.showWhen).toEqual({ key: 'presence', equals: 'version_below' });
    });

    it('backup_continuity conditional fields carry the expected showWhen', () => {
      const fields = MONITOR_KIND_FIELDS.backup_continuity;
      const maxAgeHours = fields.find((f) => f.key === 'maxAgeHours');
      const failureCount = fields.find((f) => f.key === 'failureCount');
      expect(maxAgeHours?.showWhen).toEqual({ key: 'check', equals: 'no_successful_backup' });
      expect(failureCount?.showWhen).toEqual({ key: 'check', equals: 'consecutive_failures' });
    });

    it('script omits the free-form parameters field', () => {
      expect(MONITOR_KIND_FIELDS.script.some((f) => f.key === 'parameters')).toBe(false);
    });
  });

  describe('composite children (Task 12)', () => {
    it.each(['service', 'process', 'network_check'] as const)('%s allows 100 consecutive failures', (kind) => {
      expect(MONITOR_KIND_FIELDS[kind].find((field) => field.key === 'consecutiveFailures')).toMatchObject({
        min: 1,
        max: 100,
      });
    });
  });
});

describe('monitorKindFields locale coverage (sweep pass-3 G1-2)', () => {
  const en = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../locales/en/monitoring.json'), 'utf8'),
  ) as Record<string, unknown>;
  const resolve = (dotPath: string): unknown =>
    dotPath.split('.').reduce<unknown>((cur, seg) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined), en);

  it('every field labelKey resolves to a string in the en monitoring catalog', () => {
    const missing: string[] = [];
    for (const kind of MONITOR_KINDS) {
      for (const field of MONITOR_KIND_FIELDS[kind as MonitorKind]) {
        const key = field.labelKey.replace(/^monitoring:/, '');
        if (typeof resolve(key) !== 'string') missing.push(`${kind}.${field.key} → ${field.labelKey}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every select option has a label in its option namespace', () => {
    const missing: string[] = [];
    for (const kind of MONITOR_KINDS) {
      for (const field of MONITOR_KIND_FIELDS[kind as MonitorKind]) {
        if (field.kind !== 'select' && field.kind !== 'multiselect') continue;
        const ns = SELECT_OPTION_NAMESPACE[`${kind}:${field.key}`] ?? SELECT_OPTION_NAMESPACE[field.key];
        for (const opt of field.options ?? []) {
          if (!ns || typeof resolve(`${ns}.${opt}`) !== 'string') missing.push(`${kind}.${field.key}=${opt} (ns=${ns ?? 'none'})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
