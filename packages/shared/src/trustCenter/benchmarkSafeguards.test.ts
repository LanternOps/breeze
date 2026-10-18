import { describe, expect, it } from 'vitest';
import { CIS_BENCHMARK_CHECK_SAFEGUARDS, CIS_BENCHMARK_MAPPING_SOURCES } from './benchmarkSafeguards';
import { FRAMEWORK_CROSSWALK } from './frameworkCrosswalk';

const OSES = ['windows', 'macos', 'linux'] as const;

describe('CIS_BENCHMARK_CHECK_SAFEGUARDS', () => {
  it('covers exactly the three agent OS families', () => {
    expect(Object.keys(CIS_BENCHMARK_CHECK_SAFEGUARDS).sort()).toEqual([...OSES].sort());
  });

  it('every mapped ref resolves in FRAMEWORK_CROSSWALK.cis_v8', () => {
    for (const os of OSES) {
      for (const [checkId, refs] of Object.entries(CIS_BENCHMARK_CHECK_SAFEGUARDS[os])) {
        for (const ref of refs) {
          expect(FRAMEWORK_CROSSWALK.cis_v8[ref], `${os} ${checkId} → ${ref}`).toBeDefined();
        }
      }
    }
  });

  it('refs are unique per check', () => {
    for (const os of OSES) {
      for (const [checkId, refs] of Object.entries(CIS_BENCHMARK_CHECK_SAFEGUARDS[os])) {
        expect(new Set(refs).size, `${os} ${checkId}`).toBe(refs.length);
      }
    }
  });

  it('keys by the agent check ids (windows firewall is 9.1.1, not the API catalog 9.1)', () => {
    expect(CIS_BENCHMARK_CHECK_SAFEGUARDS.windows['9.1.1']).toBeDefined();
    expect(CIS_BENCHMARK_CHECK_SAFEGUARDS.windows['9.1']).toBeUndefined();
  });

  it('no label contains a verbatim recommendation title', () => {
    for (const [ref, entry] of Object.entries(FRAMEWORK_CROSSWALK.cis_v8)) {
      expect(entry.label, ref).not.toMatch(/^Ensure\b/);
      expect(entry.label, ref).not.toMatch(/['"]/);
    }
  });
});

describe('CIS_BENCHMARK_MAPPING_SOURCES', () => {
  it('names, per OS, the benchmark title and version and the date the mapping was verified', () => {
    for (const os of OSES) {
      const s = CIS_BENCHMARK_MAPPING_SOURCES[os];
      expect(s.benchmark.length, os).toBeGreaterThan(0);
      expect(s.version, os).toMatch(/^v\d+\.\d+\.\d+$/);
      // null = not yet confirmed against the Benchmark PDF; the mapping then ships as an unverified candidate.
      if (s.verifiedAt !== null) expect(s.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['verified', 'candidate']).toContain(s.status);
      expect(s.status === 'verified', os).toBe(s.verifiedAt !== null);
    }
  });

  it('carries a per-check source note for every mapped (non-empty) entry', () => {
    for (const os of OSES) {
      const notes = CIS_BENCHMARK_MAPPING_SOURCES[os].checkNotes;
      for (const [checkId, refs] of Object.entries(CIS_BENCHMARK_CHECK_SAFEGUARDS[os])) {
        if (refs.length > 0) expect(notes[checkId], `${os} ${checkId}`).toBeTruthy();
      }
    }
  });
});
