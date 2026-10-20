// Joins the safeguard mapping to the agent's real check ids (Go sources). The API catalog
// (services/cisHardening.ts) uses different ids for some checks (Windows firewall is `9.1.1` in the agent, `9.1`
// in the catalog) and findings carry the AGENT's id, so the mapping is keyed by the agent's.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CIS_BENCHMARK_CHECK_SAFEGUARDS } from '@breeze/shared';

const CIS_DIR = path.resolve(__dirname, '../../../../agent/internal/cis');
const FILES = {
  windows: ['checks_windows.go'],
  linux: ['checks_linux.go'],
  macos: ['checks_darwin.go', 'checks_darwin_sharing.go'],
} as const;

function agentCheckIds(os: keyof typeof FILES): string[] {
  const ids = new Set<string>();
  for (const f of FILES[os]) {
    const src = readFileSync(path.join(CIS_DIR, f), 'utf8');
    for (const m of src.matchAll(/\bID:\s*"([0-9][0-9.]*)"/g)) ids.add(m[1]!);
  }
  return [...ids];
}

describe.each(Object.keys(FILES) as Array<keyof typeof FILES>)('agent CIS checks → safeguards (%s)', (os) => {
  const ids = agentCheckIds(os);

  it('finds the agent checks (guards against a regex that matches nothing)', () => {
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  it('every agent check id has an entry (an empty array is an explicit "not mapped")', () => {
    for (const id of ids) {
      expect(CIS_BENCHMARK_CHECK_SAFEGUARDS[os][id], `${os} ${id}`).toBeDefined();
    }
  });

  it('no entry names a check the agent does not run', () => {
    for (const id of Object.keys(CIS_BENCHMARK_CHECK_SAFEGUARDS[os])) {
      expect(ids, `${os} ${id}`).toContain(id);
    }
  });
});
