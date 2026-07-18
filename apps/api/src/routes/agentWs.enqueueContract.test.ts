/**
 * Static contract (#1105, BREEZE-H): every BullMQ enqueue call site in
 * agentWs.ts runs under runOutsideDbContext. The whole command_result pipeline
 * executes inside a held org-scoped transaction (runWithAgentDbAccess), so an
 * unwrapped enqueue pins a pooled Postgres connection idle-in-transaction
 * across Redis round-trips — and for instrumented queues fires the
 * assertOutsideHeldDbContext tripwire straight into Sentry. Seven sites were
 * fixed in one pass; this scan keeps the next one from regressing silently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(path.join(__dirname, 'agentWs.ts'), 'utf8');

describe('agentWs enqueue context contract (#1105)', () => {
  it('every enqueue* call site is wrapped in runOutsideDbContext', () => {
    const lines = source.split('\n');
    const callSites: number[] = [];
    lines.forEach((line, idx) => {
      if (!/\benqueue[A-Z]\w*\s*\(/.test(line)) return;
      if (/^\s*import\b/.test(line) || /\bfrom '/.test(line) || /await import\(/.test(line)) return;
      callSites.push(idx);
    });

    // Known sites: monitor, SNMP (orphaned + tracked), discovery x2, backup,
    // DR reconcile. If the scan finds fewer, the regex rotted — fix the scan,
    // don't delete the assertion.
    expect(callSites.length).toBeGreaterThanOrEqual(7);

    for (const idx of callSites) {
      const window = lines.slice(Math.max(0, idx - 3), idx + 1).join('\n');
      expect(
        window.includes('runOutsideDbContext('),
        `enqueue call at agentWs.ts:${idx + 1} must be wrapped in runOutsideDbContext (#1105):\n${lines[idx]}`
      ).toBe(true);
    }
  });
});
