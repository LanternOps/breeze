import { describe, it, expect } from 'vitest';
import {
  describePublishOutcome,
  publishSuccessMessage,
  ruleSetPatchSuccessMessage,
} from './publishOutcome';
import type { YaraPublishBody } from './ruleSetsApi';

const ENABLED = { enabled: true };
const DISABLED = { enabled: false };

function pub(over: Partial<YaraPublishBody>): YaraPublishBody {
  return { published: false, version: 3, currentVersion: 4, stale: true, errors: [], ...over };
}

const ruleErr = { ruleId: 'r1', name: 'bad_rule', code: 'compile', message: 'syntax error', line: 3 };
const setErr = { ruleId: null, name: '', code: 'cap', message: 'bundle too large' };

describe('describePublishOutcome — W04-3 table, first match wins', () => {
  it('row 1: no publish key (metadata-only PATCH) is a plain "Saved" success', () => {
    const o = describePublishOutcome(undefined, ENABLED);
    expect(o.tone).toBe('success');
    expect(o.key).toBe('saved');
  });

  it('row 2: autoQuarantineOnly is a warning whatever else is set', () => {
    const o = describePublishOutcome(
      pub({ published: true, autoQuarantineOnly: true, stale: true, version: 5, errors: [ruleErr] }),
      ENABLED,
    );
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('autoQuarantineOnly');
    expect(o.reasonKey).toBe('compileErrors');
    expect(o.ruleErrors.get('r1')).toEqual([{ code: 'compile', message: 'syntax error', line: 3 }]);
  });

  it('row 2 + precheckUnavailable: autoQuarantineOnly wins, checker-unavailable is the reason', () => {
    const o = describePublishOutcome(
      pub({ published: true, autoQuarantineOnly: true, precheckUnavailable: true, version: 5 }),
      ENABLED,
    );
    expect(o.key).toBe('autoQuarantineOnly');
    expect(o.reasonKey).toBe('checkerUnavailable');
  });

  it('row 3: published, not stale, enabled set → success with the version', () => {
    const o = describePublishOutcome(
      pub({ published: true, stale: false, version: 7, currentVersion: 7 }),
      ENABLED,
    );
    expect(o.tone).toBe('success');
    expect(o.key).toBe('published');
    expect(o.params.version).toBe(7);
    expect(o.ruleErrors.size).toBe(0);
  });

  it('row 3b: published, not stale, disabled set → success that says devices do not use it', () => {
    const o = describePublishOutcome(pub({ published: true, stale: false, version: 7 }), DISABLED);
    expect(o.tone).toBe('success');
    expect(o.key).toBe('savedDisabled');
  });

  it('row 4: precheckUnavailable → warning, no per-rule errors claimed', () => {
    const o = describePublishOutcome(pub({ precheckUnavailable: true, errors: [] }), ENABLED);
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('checkerUnavailable');
    expect(o.ruleErrors.size).toBe(0);
  });

  it('row 5: errors with a ruleId → compileErrors with the count of failing rules', () => {
    const o = describePublishOutcome(
      pub({ errors: [ruleErr, { ...ruleErr, line: 9, message: 'second' }, { ...ruleErr, ruleId: 'r2' }] }),
      ENABLED,
    );
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('compileErrors');
    expect(o.params.count).toBe(2);
    expect(o.ruleErrors.get('r1')).toHaveLength(2);
    expect(o.ruleErrors.get('r1')?.[1]).toEqual({ code: 'compile', message: 'second', line: 9 });
  });

  it('row 6: only ruleId:null errors → setErrors with the message', () => {
    const o = describePublishOutcome(pub({ errors: [setErr] }), ENABLED);
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('setErrors');
    expect(o.setErrors).toEqual(['bundle too large']);
    expect(o.params.message).toBe('bundle too large');
  });

  it('row 7: not published, version 0, no errors → no enabled rules', () => {
    const o = describePublishOutcome(pub({ published: false, version: 0, stale: false, errors: [] }), ENABLED);
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('noEnabledRules');
  });

  it('published && stale is never success', () => {
    const o = describePublishOutcome(pub({ published: true, stale: true, version: 4 }), ENABLED);
    expect(o.tone).toBe('warning');
  });

  it('{{devices}} resolves to devicesKeep / neverPublished / setDisabled', () => {
    expect(describePublishOutcome(pub({ errors: [ruleErr], version: 3 }), ENABLED).params.devicesKey).toBe('devicesKeep');
    expect(describePublishOutcome(pub({ errors: [ruleErr], version: 0 }), ENABLED).params.devicesKey).toBe(
      'neverPublished',
    );
    expect(describePublishOutcome(pub({ errors: [ruleErr], version: 3 }), DISABLED).params.devicesKey).toBe(
      'setDisabled',
    );
  });

  it('a publish-carrying mutation that answers without a publish body is not a success', () => {
    const o = describePublishOutcome(undefined, ENABLED, { expectPublish: true });
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('unknown');
  });

  it('a malformed publish body is not a success', () => {
    const o = describePublishOutcome({ published: 'yes', version: 'x', errors: null } as unknown as YaraPublishBody, ENABLED);
    expect(o.tone).toBe('warning');
    expect(o.key).toBe('unknown');
  });
});

describe('publishSuccessMessage (runAction successMessage)', () => {
  it('returns the success copy only for the success rows', () => {
    expect(publishSuccessMessage({ publish: pub({ published: true, stale: false, version: 7 }) }, ENABLED)).toContain('7');
    expect(publishSuccessMessage({ publish: pub({ published: true, stale: false, version: 7 }) }, DISABLED)).not.toBe('');
  });

  it.each([
    ['autoQuarantineOnly', pub({ published: true, autoQuarantineOnly: true, version: 5 })],
    ['checkerUnavailable', pub({ precheckUnavailable: true })],
    ['compileErrors', pub({ errors: [ruleErr] })],
    ['setErrors', pub({ errors: [setErr] })],
    ['noEnabledRules', pub({ version: 0, stale: false })],
    ['published but stale', pub({ published: true, stale: true })],
  ])('returns "" for the %s warning row', (_name, publish) => {
    expect(publishSuccessMessage({ publish }, ENABLED)).toBe('');
  });

  it.each([
    ['{}', {}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['publish: null', { publish: null }],
    ['publish: {}', { publish: {} }],
    ['wrong-typed fields', { publish: { published: 'true', version: '7', stale: 0, errors: 'none' } }],
    ['errors with junk entries', { publish: { published: false, version: 1, stale: true, errors: [null, 7, 'x'] } }],
  ])('never throws and returns "" for %s', (_name, body) => {
    expect(() => publishSuccessMessage(body as never, ENABLED)).not.toThrow();
    expect(publishSuccessMessage(body as never, ENABLED)).toBe('');
  });

  it('never throws when the set argument is junk', () => {
    expect(() => publishSuccessMessage({ publish: pub({ published: true, stale: false }) }, null as never)).not.toThrow();
  });
});

describe('ruleSetPatchSuccessMessage (set PATCH, publish optional)', () => {
  it('a metadata-only PATCH (no publish key) says Saved', () => {
    expect(ruleSetPatchSuccessMessage({ data: { enabled: true } })).toBe('Saved');
  });
  it('a PATCH that republished uses the set enabled flag from the response', () => {
    expect(
      ruleSetPatchSuccessMessage({ data: { enabled: false }, publish: pub({ published: true, stale: false, version: 2 }) }),
    ).toContain('disabled');
  });
  it('a PATCH whose republish failed returns ""', () => {
    expect(ruleSetPatchSuccessMessage({ data: { enabled: true }, publish: pub({ errors: [ruleErr] }) })).toBe('');
  });
  it.each([[null], [undefined], [{ publish: 'x' }]])('never throws on junk (%s)', (body) => {
    expect(() => ruleSetPatchSuccessMessage(body as never)).not.toThrow();
  });
});
