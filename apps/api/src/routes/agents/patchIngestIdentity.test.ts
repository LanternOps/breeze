import { describe, it, expect } from 'vitest';
import {
  normalizePatchIdentity,
  admitPatchBatch,
  mergeRejectionReasons,
  PATCH_DESCRIPTION_LIMIT,
  type PatchIdentityInput,
} from './patchIngestIdentity';

function baseInput(overrides: Partial<PatchIdentityInput> = {}): PatchIdentityInput {
  return {
    source: 'winget',
    name: 'Some Package',
    ...overrides,
  };
}

describe('normalizePatchIdentity', () => {
  it('happy path: explicit externalId used verbatim; other fields trimmed', () => {
    const result = normalizePatchIdentity(
      baseInput({
        externalId: '  KB123456  ',
        packageId: '  Some.Package.Id  ',
        version: '  1.2.3  ',
        vendor: '  Some Vendor  ',
        category: '  Security  ',
        description: '  Some description  ',
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.externalId).toBe('KB123456');
    expect(result.value.packageId).toBe('Some.Package.Id');
    expect(result.value.version).toBe('1.2.3');
    expect(result.value.vendor).toBe('Some Vendor');
    expect(result.value.category).toBe('Security');
    expect(result.value.description).toBe('Some description');
  });

  describe('externalId derivation precedence', () => {
    it('explicit externalId wins over kbNumber and composed form', () => {
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'EXPLICIT', kbNumber: 'KB999', version: '1.0' })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.externalId).toBe('EXPLICIT');
    });

    it('kbNumber wins over composed form when externalId absent', () => {
      const result = normalizePatchIdentity(baseInput({ kbNumber: 'KB999', version: '1.0' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.externalId).toBe('KB999');
    });

    it('composes source:name:version when neither externalId nor kbNumber given', () => {
      const result = normalizePatchIdentity(baseInput({ version: '1.0' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.externalId).toBe('winget:Some Package:1.0');
    });

    it('composed form falls back to "latest" when version absent', () => {
      const result = normalizePatchIdentity(baseInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.externalId).toBe('winget:Some Package:latest');
    });
  });

  it('accepts Apple-style values with spaces (regression guard)', () => {
    const appleId = 'macOS Sonoma 14.5-23F79';
    const result = normalizePatchIdentity(
      baseInput({ source: 'apple-softwareupdate', externalId: appleId, packageId: appleId })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.externalId).toBe(appleId);
    expect(result.value.packageId).toBe(appleId);
  });

  describe('control character rejection', () => {
    it('rejects externalId containing control characters', () => {
      const result = normalizePatchIdentity(baseInput({ externalId: 'KB\x01123' }));
      expect(result).toEqual({ ok: false, reason: 'external_id_control_chars' });
    });

    it('rejects externalId containing a newline', () => {
      const result = normalizePatchIdentity(baseInput({ externalId: 'KB123\n456' }));
      expect(result).toEqual({ ok: false, reason: 'external_id_control_chars' });
    });

    it('rejects packageId containing control characters', () => {
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'KB123', packageId: 'pkg\x01id' })
      );
      expect(result).toEqual({ ok: false, reason: 'package_id_control_chars' });
    });

    it('rejects packageId containing a newline', () => {
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'KB123', packageId: 'pkg\nid' })
      );
      expect(result).toEqual({ ok: false, reason: 'package_id_control_chars' });
    });
  });

  describe('option-like id rejection', () => {
    it('rejects a packageId that looks like a CLI flag', () => {
      const result = normalizePatchIdentity(baseInput({ externalId: 'KB123', packageId: '--force' }));
      expect(result).toEqual({ ok: false, reason: 'package_id_option_like' });
    });

    it('rejects a provider-prefixed packageId whose local segment is option-like', () => {
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'KB123', packageId: 'apple-softwareupdate:--all' })
      );
      expect(result).toEqual({ ok: false, reason: 'package_id_option_like' });
    });

    it('rejects an externalId that looks like a CLI flag', () => {
      const result = normalizePatchIdentity(baseInput({ externalId: '--force' }));
      expect(result).toEqual({ ok: false, reason: 'external_id_option_like' });
    });

    it('rejects a provider-prefixed externalId whose local segment is option-like', () => {
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'apple-softwareupdate:--all' })
      );
      expect(result).toEqual({ ok: false, reason: 'external_id_option_like' });
    });
  });

  describe('length rejection', () => {
    it('rejects when derived externalId exceeds 255 chars', () => {
      const longId = 'K'.repeat(256);
      const result = normalizePatchIdentity(baseInput({ externalId: longId }));
      expect(result).toEqual({ ok: false, reason: 'external_id_too_long' });
    });

    it('rejects when packageId exceeds 256 chars', () => {
      const longPkg = 'p'.repeat(257);
      const result = normalizePatchIdentity(baseInput({ externalId: 'KB123', packageId: longPkg }));
      expect(result).toEqual({ ok: false, reason: 'package_id_too_long' });
    });
  });

  it('rejects whitespace-only name with empty_title', () => {
    const result = normalizePatchIdentity(baseInput({ name: '   ' }));
    expect(result).toEqual({ ok: false, reason: 'empty_title' });
  });

  describe('length policy split (truncate vs null)', () => {
    it('truncates an over-length title to 500 and still admits the row', () => {
      const longTitle = 'T'.repeat(600);
      const result = normalizePatchIdentity(baseInput({ name: longTitle, externalId: 'KB123' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.title).toHaveLength(500);
      expect(result.value.title).toBe(longTitle.slice(0, 500));
    });

    it('nulls out an over-length version (>64) instead of truncating, and still admits', () => {
      const longVersion = '9'.repeat(65);
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'KB123', version: longVersion })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.version).toBeNull();
    });

    it('nulls out an over-length category (>100) instead of truncating, and still admits', () => {
      const longCategory = 'c'.repeat(101);
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'KB123', category: longCategory })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.category).toBeNull();
    });

    it('truncates description beyond PATCH_DESCRIPTION_LIMIT', () => {
      const longDescription = 'd'.repeat(PATCH_DESCRIPTION_LIMIT + 500);
      const result = normalizePatchIdentity(
        baseInput({ externalId: 'KB123', description: longDescription })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.description).toHaveLength(PATCH_DESCRIPTION_LIMIT);
      expect(result.value.description).toBe(longDescription.slice(0, PATCH_DESCRIPTION_LIMIT));
    });
  });

  it('normalizes empty strings to null', () => {
    const result = normalizePatchIdentity(
      baseInput({
        externalId: 'KB123',
        packageId: '',
        version: '',
        vendor: '',
        category: '',
        description: '',
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageId).toBeNull();
    expect(result.value.version).toBeNull();
    expect(result.value.vendor).toBeNull();
    expect(result.value.category).toBeNull();
    expect(result.value.description).toBeNull();
  });
});

describe('admitPatchBatch', () => {
  it('splits a mixed batch into admitted (preserving order + original data) and rejected count', () => {
    const good1 = baseInput({ externalId: 'KB1', name: 'Good One' });
    const bad = baseInput({ externalId: '--bad', name: 'Bad One' });
    const good2 = baseInput({ externalId: 'KB2', name: 'Good Two' });

    const result = admitPatchBatch([good1, bad, good2]);

    expect(result.admitted).toHaveLength(2);
    expect(result.rejected).toBe(1);
    expect(result.admitted[0]?.data).toBe(good1);
    expect(result.admitted[0]?.identity.externalId).toBe('KB1');
    expect(result.admitted[1]?.data).toBe(good2);
    expect(result.admitted[1]?.identity.externalId).toBe('KB2');
  });

  it('reasons is a histogram keyed by rejection reason with correct counts', () => {
    const row1 = baseInput({ externalId: 'KBbad1', name: 'Row One' });
    const row2 = baseInput({ externalId: 'KBbad2', name: 'Row Two' });

    const result = admitPatchBatch([row1, row2]);

    expect(result.rejected).toBe(2);
    expect(result.reasons).toEqual({ external_id_control_chars: 2 });
  });

  it('returns empty admission for empty input', () => {
    const result = admitPatchBatch([]);
    expect(result).toEqual({ admitted: [], rejected: 0, reasons: {} });
  });
});

describe('mergeRejectionReasons', () => {
  it('sums counts for a reason present on both sides (load-bearing: object spread would drop one side)', () => {
    const a = { external_id_too_long: 2 };
    const b = { external_id_too_long: 3 };
    const result = mergeRejectionReasons(a, b);
    expect(result).toEqual({ external_id_too_long: 5 });
  });

  it('keeps disjoint keys from both sides', () => {
    const a = { external_id_too_long: 1 };
    const b = { package_id_option_like: 4 };
    const result = mergeRejectionReasons(a, b);
    expect(result).toEqual({ external_id_too_long: 1, package_id_option_like: 4 });
  });

  it('is a no-op when either side is empty', () => {
    const populated = { empty_title: 2 };
    expect(mergeRejectionReasons(populated, {})).toEqual({ empty_title: 2 });
    expect(mergeRejectionReasons({}, populated)).toEqual({ empty_title: 2 });
  });

  it('does not mutate either input object', () => {
    const a = { external_id_too_long: 2 };
    const b = { external_id_too_long: 3, empty_title: 1 };
    const aCopy = { ...a };
    const bCopy = { ...b };

    mergeRejectionReasons(a, b);

    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});
