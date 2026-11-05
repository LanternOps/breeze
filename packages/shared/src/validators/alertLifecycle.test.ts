import { describe, expect, it } from 'vitest';
import { alertLifecycleDefaultsSchema, rearmFieldsSchema } from './alertLifecycle';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const partnerBody = {
  scope: 'partner',
  autoResolve: false,
  rearmMode: 'new_evidence',
  rearmDelayMinutes: null,
  cooldownMinutes: 5,
};

const orgBody = {
  scope: 'organization',
  orgId: ORG_ID,
  autoResolve: null,
  rearmMode: null,
  rearmDelayMinutes: null,
  cooldownMinutes: null,
};

function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('rearmFieldsSchema', () => {
  it('after_delay requires minutes', () => {
    const missing = rearmFieldsSchema.safeParse({ rearmMode: 'after_delay' });
    expect(missing.success).toBe(false);
    expect(issuePaths(missing)).toContain('rearmDelayMinutes');
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: null }).success).toBe(false);
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: 30 }).success).toBe(true);
  });

  it('rejects minutes without after_delay', () => {
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'new_evidence', rearmDelayMinutes: 30 }).success).toBe(false);
    expect(rearmFieldsSchema.safeParse({ rearmMode: null, rearmDelayMinutes: 30 }).success).toBe(false);
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'new_evidence', rearmDelayMinutes: null }).success).toBe(true);
  });

  it('leaves the pair to the merged row when the mode is omitted (partial update)', () => {
    expect(rearmFieldsSchema.safeParse({}).success).toBe(true);
    expect(rearmFieldsSchema.safeParse({ rearmDelayMinutes: 45 }).success).toBe(true);
  });

  it('bounds the delay to 1–1440 whole minutes', () => {
    for (const bad of [0, 1441, 1.5, -1]) {
      expect(rearmFieldsSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: bad }).success).toBe(false);
    }
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: 1 }).success).toBe(true);
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'after_delay', rearmDelayMinutes: 1440 }).success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(rearmFieldsSchema.safeParse({ rearmMode: 'always' }).success).toBe(false);
  });
});

describe('alertLifecycleDefaultsSchema', () => {
  it('accepts a full partner default', () => {
    expect(alertLifecycleDefaultsSchema.safeParse(partnerBody).success).toBe(true);
    expect(alertLifecycleDefaultsSchema.safeParse({
      ...partnerBody, rearmMode: 'after_delay', rearmDelayMinutes: 60,
    }).success).toBe(true);
  });

  it('partner values are non-null: the partner default has nothing to inherit from', () => {
    for (const field of ['autoResolve', 'rearmMode', 'cooldownMinutes'] as const) {
      const result = alertLifecycleDefaultsSchema.safeParse({ ...partnerBody, [field]: null });
      expect(result.success, field).toBe(false);
    }
  });

  it('org values are nullable: null saves inherit', () => {
    const parsed = alertLifecycleDefaultsSchema.parse(orgBody);
    expect(parsed).toEqual(orgBody);
    expect(alertLifecycleDefaultsSchema.safeParse({
      ...orgBody, autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 15, cooldownMinutes: 0,
    }).success).toBe(true);
  });

  it('every field is required so a PUT can never wipe an omitted value', () => {
    const { cooldownMinutes: _omit, ...orgWithout } = orgBody;
    expect(alertLifecycleDefaultsSchema.safeParse(orgWithout).success).toBe(false);
    const { rearmDelayMinutes: _omit2, ...partnerWithout } = partnerBody;
    expect(alertLifecycleDefaultsSchema.safeParse(partnerWithout).success).toBe(false);
  });

  it('after_delay without minutes is rejected at both scopes', () => {
    const partner = alertLifecycleDefaultsSchema.safeParse({ ...partnerBody, rearmMode: 'after_delay' });
    expect(partner.success).toBe(false);
    expect(issuePaths(partner)).toContain('rearmDelayMinutes');
    expect(alertLifecycleDefaultsSchema.safeParse({ ...orgBody, rearmMode: 'after_delay' }).success).toBe(false);
    expect(alertLifecycleDefaultsSchema.safeParse({ ...orgBody, rearmDelayMinutes: 20 }).success).toBe(false);
  });

  it('bounds cooldown to 0–1440', () => {
    expect(alertLifecycleDefaultsSchema.safeParse({ ...partnerBody, cooldownMinutes: 1441 }).success).toBe(false);
    expect(alertLifecycleDefaultsSchema.safeParse({ ...partnerBody, cooldownMinutes: -1 }).success).toBe(false);
    expect(alertLifecycleDefaultsSchema.safeParse({ ...partnerBody, cooldownMinutes: 0 }).success).toBe(true);
  });

  it('requires a uuid orgId at organization scope and an explicit scope', () => {
    expect(alertLifecycleDefaultsSchema.safeParse({ ...orgBody, orgId: 'nope' }).success).toBe(false);
    const { orgId: _omit, ...noOrg } = orgBody;
    expect(alertLifecycleDefaultsSchema.safeParse(noOrg).success).toBe(false);
    const { scope: _scope, ...noScope } = partnerBody;
    expect(alertLifecycleDefaultsSchema.safeParse(noScope).success).toBe(false);
  });
});
