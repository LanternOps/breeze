import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PARTNER_SETTINGS_CATALOG, CATALOG_BY_ID } from '@breeze/shared';
import { isSecretJsonPath } from '../encryptedColumnTransform';
import { SETTINGS_SECRET_JSON_PATHS } from '../encryptedColumnRegistry';
import { BINDINGS, BUCKETS, type Bucket } from './bindings';

const dialect = new PgDialect();

/** A partner settings blob that sets every catalog path the classified entries read. */
const PARTNER_ALL_SET = {
  security: { requireMfa: true, sessionTimeout: 30 },
  notifications: {
    pushoverAppToken: 'FIXTURE-PARTNER-TOKEN',
    pushoverDefaultUser: 'FIXTURE-PARTNER-USER',
    pushoverDefaultSound: 'siren',
    pushoverDefaultPriority: 1,
  },
  eventLogs: { enabled: true, elasticsearchUrl: 'https://partner.example' },
  defaults: {
    agentUpdatePolicy: 'manual',
    maintenanceWindow: 'Sun 02:00-04:00',
    agentVersionPins: { agent: '0.90.0', watchdog: '0.90.0' },
    defaultEnrollmentTtlMinutes: 60,
    defaultEnrollmentDeviceCount: 5,
    maxEnrollmentLinkTtlMinutes: 120,
  },
  aiBudgets: { enabled: true, maxTurnsPerSession: 9, monthlyBudgetCents: null },
  aiApprovals: { interactiveTimeoutMinutes: 15 },
};

describe('partner settings inheritance bindings', () => {
  it('every catalog entry has a binding', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      expect(BINDINGS[entry.id], entry.id).toBeDefined();
      expect(BINDINGS[entry.id]!.id).toBe(entry.id);
    }
  });

  it('no binding without a catalog entry', () => {
    for (const id of Object.keys(BINDINGS)) expect(CATALOG_BY_ID[id], id).toBeDefined();
  });

  it('only classified, non-partner-only entries have an org source', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      const hasSource = BINDINGS[entry.id]!.orgSource !== null;
      expect(hasSource, entry.id).toBe(entry.kind === 'locks' || entry.kind === 'overridable');
    }
  });

  it('secret flag covers every sealed settings path', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      const sealed = entry.paths.some((path) => isSecretJsonPath(path.split('.'), SETTINGS_SECRET_JSON_PATHS));
      if (sealed) expect(entry.secret, entry.id).toBe(true);
    }
  });

  it('secret fields project presence only', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.secret)) {
      const binding = BINDINGS[entry.id]!;
      for (const value of ['s3cr3t', 'enc:v1:abc', 42, true, { password: 'x' }]) {
        expect(binding.project(value), entry.id).toBeUndefined();
      }
    }
  });

  it('projection never returns a secret path', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.projection.kind !== 'presence')) {
      const binding = BINDINGS[entry.id]!;
      for (const value of ['auto', '#aabbcc', '0.90.0', 30, true, { password: 'x', token: 'y' }, ['a']]) {
        const projected = binding.project(value);
        // Projections are scalars; an object or array never passes through.
        expect(projected === undefined || typeof projected !== 'object', entry.id).toBe(true);
        if (projected && typeof projected === 'object') {
          for (const key of Object.keys(projected)) {
            expect(isSecretJsonPath([...entry.paths[0]!.split('.'), key])).toBe(false);
          }
        }
      }
    }
  });

  it('secret overrides is not computable', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.secret)) {
      expect(BINDINGS[entry.id]!.bucketSql('overrides', PARTNER_ALL_SET), entry.id).toBeNull();
    }
  });

  it('clamped only exists for cap fields', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      const clamped = BINDINGS[entry.id]!.bucketSql('clamped', PARTNER_ALL_SET);
      expect(clamped !== null, entry.id).toBe(entry.qualifier === 'cap');
    }
  });

  it('a bucket applies only to the kinds it describes', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => BINDINGS[e.id]!.orgSource !== null)) {
      const binding = BINDINGS[entry.id]!;
      expect(binding.bucketSql('ownValue', PARTNER_ALL_SET), entry.id).not.toBeNull();
      expect(binding.bucketSql('shadowed', PARTNER_ALL_SET) !== null, entry.id).toBe(entry.kind === 'locks');
      expect(binding.bucketSql('overrides', PARTNER_ALL_SET) !== null, entry.id).toBe(entry.kind === 'overridable' && !entry.secret);
    }
  });

  it('every cap field can say whether an org value is clamped', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.qualifier === 'cap')) {
      expect(typeof BINDINGS[entry.id]!.clamped, entry.id).toBe('function');
    }
  });

  it('entries without an org source compute no bucket', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => BINDINGS[e.id]!.orgSource === null)) {
      for (const bucket of BUCKETS) expect(BINDINGS[entry.id]!.bucketSql(bucket, PARTNER_ALL_SET), `${entry.id}/${bucket}`).toBeNull();
    }
  });

  it('bucketSql compiles with bound parameters only', () => {
    const fixtureStrings = ['FIXTURE-PARTNER-TOKEN', 'FIXTURE-PARTNER-USER', 'siren', 'Sun 02:00-04:00', '0.90.0', 'https://partner.example'];
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      for (const bucket of BUCKETS as readonly Bucket[]) {
        const predicate = BINDINGS[entry.id]!.bucketSql(bucket, PARTNER_ALL_SET);
        if (!predicate) continue;
        const { sql: text } = dialect.sqlToQuery(predicate);
        for (const fixture of fixtureStrings) expect(text, `${entry.id}/${bucket}`).not.toContain(fixture);
        // No catalog id or path segment is ever rendered into SQL text.
        expect(text, `${entry.id}/${bucket}`).not.toContain(entry.id);
      }
    }
    // The partner value reaches the overrides predicate as a parameter.
    const pins = dialect.sqlToQuery(BINDINGS['defaults.agentVersionPins.agent']!.bucketSql('overrides', PARTNER_ALL_SET)!);
    expect(pins.params).toContain(JSON.stringify('0.90.0'));
    const sound = dialect.sqlToQuery(BINDINGS['notifications.pushoverDefaultSound']!.bucketSql('overrides', PARTNER_ALL_SET)!);
    expect(sound.params).toContain(JSON.stringify('siren'));
  });

  it('JSON paths reach SQL only as a bound text[]', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      const source = BINDINGS[entry.id]!.orgSource;
      if (source?.kind !== 'orgSettings') continue;
      const { sql: text, params } = dialect.sqlToQuery(BINDINGS[entry.id]!.bucketSql('ownValue', PARTNER_ALL_SET)!);
      expect(text, entry.id).toMatch(/#> \$\d+::text\[\]/);
      expect(params, entry.id).toContainEqual(source.path);
      for (const segment of source.path) expect(text, entry.id).not.toContain(`'${segment}'`);
    }
  });

  it('every binding path segment and pushover key is a safe identifier', () => {
    for (const binding of Object.values(BINDINGS)) {
      const source = binding.orgSource;
      if (source?.kind === 'orgSettings') for (const segment of source.path) expect(segment).toMatch(/^[A-Za-z0-9_]+$/);
      if (source?.kind === 'pushoverChannels') expect(source.key).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it('a blank pushover credential is not an own value, an undefined sound or priority is not either', () => {
    const token = BINDINGS['notifications.pushoverAppToken']!;
    expect(token.hasOwnValue('')).toBe(false);
    expect(token.hasOwnValue('   ')).toBe(false);
    expect(token.hasOwnValue(' ﻿')).toBe(false);
    expect(token.hasOwnValue('tok')).toBe(true);
    const sound = BINDINGS['notifications.pushoverDefaultSound']!;
    expect(sound.hasOwnValue(undefined)).toBe(false);
    // A stored empty string or null is kept by the resolver (it only fills undefined).
    expect(sound.hasOwnValue('')).toBe(true);
    expect(sound.hasOwnValue(null)).toBe(true);
  });

  it('an invalid AI approval timeout is not an own value', () => {
    const binding = BINDINGS['aiApprovals.interactiveTimeoutMinutes']!;
    expect(binding.hasOwnValue(30)).toBe(true);
    expect(binding.hasOwnValue(4)).toBe(false);
    expect(binding.hasOwnValue(30.5)).toBe(false);
    expect(binding.hasOwnValue('30')).toBe(false);
  });

  it('an AI budget column counts as set only when non-null', () => {
    const binding = BINDINGS['aiBudgets.maxTurnsPerSession']!;
    expect(binding.hasOwnValue(null)).toBe(false);
    expect(binding.hasOwnValue(undefined)).toBe(false);
    expect(binding.hasOwnValue(0)).toBe(true);
  });
});
