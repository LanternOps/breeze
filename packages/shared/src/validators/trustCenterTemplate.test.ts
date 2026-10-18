import { describe, expect, it } from 'vitest';
import { trustTemplateUpdateSchema } from './trustCenterTemplate';
import { TRUST_INTRO_MAX_CHARS } from './trustCenter';

describe('trustTemplateUpdateSchema (W02g)', () => {
  it('requires expectedRevision and accepts it alone (a no-op save)', () => {
    expect(trustTemplateUpdateSchema.safeParse({}).success).toBe(false);
    expect(trustTemplateUpdateSchema.parse({ expectedRevision: 0 })).toEqual({ expectedRevision: 0 });
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: -1 }).success).toBe(false);
  });

  it('every setting is nullable-optional: null = clear (fall through to the Breeze default)', () => {
    const v = trustTemplateUpdateSchema.parse({
      expectedRevision: 2, introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null,
      showManagedBy: null, showHistory: null, hiddenControlIds: null, frameworkView: null,
    });
    expect(v.showManagedBy).toBeNull();
    expect(v.frameworkView).toBeNull();
  });

  it('accepts real values', () => {
    const v = trustTemplateUpdateSchema.parse({
      expectedRevision: 0, introHtml: '<p>Hi</p>', showManagedBy: false, hiddenControlIds: ['mfa_enforced_m365'], frameworkView: ['nist_csf_2'],
    });
    expect(v).toMatchObject({ introHtml: '<p>Hi</p>', showManagedBy: false, frameworkView: ['nist_csf_2'] });
  });

  it('bounds the raw intro, rejects unknown controls, duplicate frameworks and unknown keys', () => {
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: 0, introHtml: 'x'.repeat(TRUST_INTRO_MAX_CHARS + 1) }).success).toBe(false);
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: 0, hiddenControlIds: ['nope'] }).success).toBe(false);
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: 0, frameworkView: ['nist_csf_2', 'nist_csf_2'] }).success).toBe(false);
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: 0, frameworkView: ['iso_9001'] }).success).toBe(false);
    // Org-only settings never live on the partner template.
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: 0, ndaText: 'x' }).success).toBe(false);
    expect(trustTemplateUpdateSchema.safeParse({ expectedRevision: 0, securityContactEmail: 'a@b.co' }).success).toBe(false);
  });
});
