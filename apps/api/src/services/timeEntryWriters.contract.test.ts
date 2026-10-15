/**
 * #4617 spec §5.1 — the customer approval gate runs in the time-entry writers
 * of timeEntryService.ts. A new code path that INSERTs or UPDATEs
 * time_entries elsewhere would write billable time the gate never saw (or
 * clear a hold without the gate), so every such statement must live in a file
 * on this allowlist. Adding a file here is a review decision: say in the PR
 * why the new writer cannot route through timeEntryService.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

/** Files allowed to write time_entries, and why. Paths are relative to apps/api/src. */
export const TIME_ENTRY_WRITER_ALLOWLIST: Record<string, string> = {
  'services/timeEntryService.ts': 'the four gated writers (create, start, stop, update) + delete/approve',
  'services/ticketApproval/requests.ts': 'the gate itself: holds an entry on a request',
  'services/ticketApproval/decisions.ts': 'the gate itself: approve/cancel/re-ask/write-off release or re-hold',
  'services/invoiceService.ts': 'issue (not_billed -> billed) and void (billed -> not_billed); held entries are never gathered',
  'services/contractHourBlockClose.ts': 'period close claims not_billed entries only (never awaiting_approval)',
  'services/deviceOrgMove/moveDeviceOrgInTransaction.ts': 'org_id re-stamp on a device org move',
  'services/ticketService.ts': 'org_id re-stamp on a ticket org move',
  'services/tenantCascade.ts': 'org erasure',
  'services/orgMergeRegistry.ts': 'org merge repoint',
};

const WRITE_PATTERNS: RegExp[] = [
  /\b(?:insert|update)\(\s*timeEntries\s*\)/,
  /\bUPDATE\s+(?:public\.)?time_entries\b/i,
  /\bINSERT\s+INTO\s+(?:public\.)?time_entries\b/i,
  /identifier\(\s*['"]time_entries['"]\s*\)/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

export function findTimeEntryWriters(srcRoot = SRC): string[] {
  return walk(srcRoot)
    .filter((file) => WRITE_PATTERNS.some((re) => re.test(readFileSync(file, 'utf8'))))
    .map((file) => path.relative(srcRoot, file).split(path.sep).join('/'))
    .sort();
}

describe('time_entries writers (customer approval gate, #4617 spec §5.1)', () => {
  let found: string[] = [];
  // One scan of apps/api/src (thousands of files) shared by both assertions.
  beforeAll(() => { found = findTimeEntryWriters(); }, 120_000);

  it('every INSERT/UPDATE of time_entries lives in an allowlisted file', () => {
    const offenders = found.filter((f) => !(f in TIME_ENTRY_WRITER_ALLOWLIST));
    expect(offenders, [
      'These files write time_entries outside the approval gate.',
      'Route the write through timeEntryService (createTimeEntry / startTimer / stopTimer / updateTimeEntry),',
      'which runs evaluateApprovalGate under the ticket lock, or add the file to',
      'TIME_ENTRY_WRITER_ALLOWLIST with the reason it cannot.',
    ].join(' ')).toEqual([]);
  });

  it('the scan actually finds the known writers (guards against a pattern that matches nothing)', () => {
    expect(found).toContain('services/timeEntryService.ts');
    expect(found).toContain('services/invoiceService.ts');
    expect(found).toContain('services/ticketApproval/requests.ts');
  });
});
