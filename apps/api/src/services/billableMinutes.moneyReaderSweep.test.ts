import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Spec §3.5 (#4628 W03). The money rule is `COALESCE(billable_minutes,
 * duration_minutes)` — the billed quantity, falling back to the worked duration
 * for rows stamped before this wave. `billableMinutes.ts` states it in prose,
 * and several independent readers have to honour it.
 *
 * Prose did not hold. W03's own sweep moved `invoiceAssembly` and the ticket
 * summary and missed `orgCurrencyService.laborSumSql`, whose docblock claimed
 * parity with `invoiceAssembly.timeEntryToLineSpec` while it kept multiplying
 * the raw `duration_minutes` by the rate. The org-currency preflight — the
 * screen an MSP reads before changing an org's currency — then understated the
 * stranded labour by the whole minimum: thirty 20-minute entries on a 60-minute
 * minimum previewed at 10 h and invoiced at 30 h. Nothing else would have
 * caught it; the CHECK constraint does not reach a read.
 *
 * Hence a source sweep rather than another comment. A line that multiplies
 * time-entry minutes by an hourly rate is a money read, and a money read that
 * names `durationMinutes` must name `billableMinutes` in the same breath —
 * whether it does the COALESCE in SQL or hands both columns to JS.
 */

const API_SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
    return full.endsWith('.ts') && !full.includes('.test.') ? [full] : [];
  });
}

describe('money readers over time_entries bill the minimum (#4628 W03)', () => {
  it('no money read multiplies the raw duration by a rate', () => {
    const offenders: string[] = [];

    for (const file of walk(API_SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // A money read: the hourly rate and the worked duration on one line.
        if (!line.includes('timeEntries.hourlyRate')) return;
        if (!line.includes('timeEntries.durationMinutes')) return;
        // ...which must carry the billed quantity too, or it bills the raw time.
        if (line.includes('timeEntries.billableMinutes')) return;
        offenders.push(`${file.replace(API_SRC, 'apps/api/src')}:${i + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
