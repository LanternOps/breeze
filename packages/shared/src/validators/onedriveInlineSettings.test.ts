import { describe, it, expect } from 'vitest';
import {
  onedriveHelperInlineSettingsSchema,
  onedriveLibraryMappingSchema,
  addFeatureLinkSchema,
} from './index';

describe('onedriveHelperInlineSettingsSchema', () => {
  it('applies defaults on an empty object', () => {
    const parsed = onedriveHelperInlineSettingsSchema.parse({});
    expect(parsed.silentAccountConfig).toBe(true);
    expect(parsed.filesOnDemand).toBe(true);
    expect(parsed.kfmSilentOptIn).toBe(false);
    expect(parsed.kfmFolders).toEqual(['Desktop', 'Documents', 'Pictures']);
    expect(parsed.restartOnChange).toBe(true);
    expect(parsed.libraries).toEqual([]);
  });

  it('accepts a full valid payload', () => {
    const parsed = onedriveHelperInlineSettingsSchema.parse({
      kfmSilentOptIn: true,
      kfmFolders: ['Documents'],
      tenantAssociationId: '02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c',
      libraries: [
        { libraryId: 'tenantId=x&siteId={y}&webId={z}&listId={w}&webUrl=u&version=1', displayName: 'Finance', targetingMode: 'graph_group', groupId: 'g-1' },
        { libraryId: 'tenantId=x&siteId={a}&webId={b}&listId={c}&webUrl=u2&version=1', displayName: 'Company', targetingMode: 'everyone' },
      ],
    });
    expect(parsed.libraries).toHaveLength(2);
    expect(parsed.libraries[0]!.hiveScope).toBe('hkcu');
    expect(parsed.libraries[1]!.enabled).toBe(true);
  });

  it('rejects an invalid targetingMode', () => {
    expect(() => onedriveLibraryMappingSchema.parse({
      libraryId: 'x', displayName: 'X', targetingMode: 'nonsense',
    })).toThrow();
  });

  it('rejects graph_group without groupId or groupName', () => {
    const res = onedriveLibraryMappingSchema.safeParse({
      libraryId: 'x', displayName: 'X', targetingMode: 'graph_group',
    });
    expect(res.success).toBe(false);
  });

  it('rejects local_ad_group without groupName', () => {
    const res = onedriveLibraryMappingSchema.safeParse({
      libraryId: 'x', displayName: 'X', targetingMode: 'local_ad_group', groupId: 'sid-only',
    });
    expect(res.success).toBe(false);
  });

  it('rejects more than 100 libraries', () => {
    const libs = Array.from({ length: 101 }, (_, i) => ({
      libraryId: `lib-${i}`, displayName: `L${i}`, targetingMode: 'everyone',
    }));
    expect(onedriveHelperInlineSettingsSchema.safeParse({ libraries: libs }).success).toBe(false);
  });

  it('rejects an out-of-set KFM folder', () => {
    expect(onedriveHelperInlineSettingsSchema.safeParse({ kfmFolders: ['Downloads'] }).success).toBe(false);
  });
});

describe('addFeatureLinkSchema onedrive_helper', () => {
  it('accepts featureType onedrive_helper with inlineSettings', () => {
    const res = addFeatureLinkSchema.safeParse({
      featureType: 'onedrive_helper',
      inlineSettings: { silentAccountConfig: true },
    });
    expect(res.success).toBe(true);
  });
});
