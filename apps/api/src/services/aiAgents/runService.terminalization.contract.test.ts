// apps/api/src/services/aiAgents/runService.terminalization.contract.test.ts
/**
 * Wave 6 PR 2 (#3828) — the terminalization contract. After this PR, exactly
 * ONE place in production code may set a TERMINAL `ai_agent_runs.status`:
 * `transitionRunStatus` (this directory's `runService.ts`), which is also the
 * ONE call site for `agentCircuit.ts`'s `recordRunTerminal`. A writer that
 * bypasses it — a raw `.update(aiAgentRuns).set({ status: 'failed', ... })`
 * anywhere else — would silently starve the per-org circuit breaker of the
 * failures it exists to count.
 *
 * Mirrors `jobs/agentDispatchBoundary.contract.test.ts`'s source-scan
 * mechanism: a plain regex over every production `.ts` file's TEXT, not a
 * type-level or AST check. `transitionRunStatus` itself sets
 * `status: to` — a PARAMETER, never a quoted literal — so the pattern below
 * does not need to special-case its own file; the chokepoint is scanned like
 * everything else and stays clean by construction.
 *
 * "Red-proof": the two self-check tests below prove the pattern actually
 * discriminates (matches a deliberately bad snippet, does not match the
 * chokepoint's own literal-free write) rather than vacuously matching
 * nothing. During development this was additionally verified by temporarily
 * reintroducing the OLD raw `.set({ status: 'failed', errorCode: 'stalled',
 * ... })` write in `reapStalledAgentRuns` and confirming the full-repo scan
 * below turned red before converting it back to route through
 * `transitionRunStatus`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This file lives at src/services/aiAgents/ — two levels below src/.
const SRC_DIR = fileURLToPath(new URL('../../', import.meta.url));

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired', 'skipped', 'awaiting_approval'];

/**
 * Matches `.update(aiAgentRuns) ... .set({ ... status: '<terminal>' ... })`,
 * tolerant of the update/set calls spanning several lines (this repo's own
 * style, see runService.ts) but bounded (`{0,400}`) so it cannot bridge into
 * an unrelated, much later statement in the same file.
 */
function buildTerminalWritePattern(): RegExp {
  const statuses = TERMINAL_STATUSES.join('|');
  return new RegExp(
    `update\\(\\s*aiAgentRuns\\s*\\)[\\s\\S]{0,400}?\\.set\\(\\s*\\{[\\s\\S]{0,400}?status:\\s*['"](?:${statuses})['"]`,
  );
}

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const pattern = buildTerminalWritePattern();

// Cheap pre-filter: only files that mention the identifier at all could
// possibly contain a raw writer for it. This keeps the it.each list scoped
// to the handful of files that actually touch `ai_agent_runs`, rather than
// running (and printing) ~1,500 trivially-passing cases — while still being
// a genuine full-repo scan, since a file that doesn't even reference
// `aiAgentRuns` cannot match the pattern regardless.
const candidateFiles = productionSources(SRC_DIR).filter((f) => readFileSync(f, 'utf8').includes('aiAgentRuns'));

describe('ai_agent_runs terminalization chokepoint (#3828)', () => {
  it('found production files that reference aiAgentRuns to scan', () => {
    // Sanity floor against the substring filter itself silently excluding
    // everything (e.g. a typo) and making every case below vacuously pass.
    expect(candidateFiles.length).toBeGreaterThan(5);
    expect(candidateFiles.some((f) => f.endsWith('runService.ts'))).toBe(true);
  });

  it('red-proof: the pattern DOES flag a raw terminal-status writer', () => {
    const bad = `
      await db
        .update(aiAgentRuns)
        .set({ status: 'failed', errorCode: 'stalled', finishedAt: new Date() })
        .where(and(eq(aiAgentRuns.agentId, scope.agentId), eq(aiAgentRuns.orgId, scope.orgId)));
    `;
    expect(pattern.test(bad)).toBe(true);
  });

  it('red-proof: the pattern does NOT flag the chokepoint\'s own literal-free write', () => {
    const chokepoint = `
      const rows = await db
        .update(aiAgentRuns)
        .set({ ...patch, status: to })
        .where(and(eq(aiAgentRuns.id, runId), inArray(aiAgentRuns.status, fromStatuses)))
        .returning({ id: aiAgentRuns.id });
    `;
    expect(pattern.test(chokepoint)).toBe(false);
  });

  it('red-proof: a non-terminal literal (queued/running) is not flagged', () => {
    const reclaim = `
      await db
        .update(aiAgentRuns)
        .set({ status: 'queued', errorCode: null })
        .where(...);
    `;
    expect(pattern.test(reclaim)).toBe(false);
  });

  it.each(candidateFiles.map((f) => [f.slice(SRC_DIR.length), f]))('%s', (_label, full) => {
    const src = readFileSync(full, 'utf8');
    expect(
      pattern.test(src),
      `${full} appears to set a terminal ai_agent_runs.status directly — `
      + 'route through transitionRunStatus (services/aiAgents/runService.ts) instead, '
      + 'or the per-org circuit breaker silently stops counting this failure path.',
    ).toBe(false);
  });
});
