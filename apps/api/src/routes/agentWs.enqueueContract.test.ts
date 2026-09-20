/**
 * Static contract (#1105, BREEZE-H): every BullMQ enqueue call site in the
 * command_result pipeline runs under runOutsideDbContext. That pipeline
 * executes inside a held org-scoped transaction (runWithAgentDbAccess), so an
 * unwrapped enqueue pins a pooled Postgres connection idle-in-transaction
 * across Redis round-trips — and for instrumented queues fires the
 * assertOutsideHeldDbContext tripwire straight into Sentry. Seven sites were
 * fixed in one pass; this scan keeps the next one from regressing silently.
 *
 * #3097 split the pipeline across two files: the per-command-type handlers moved
 * to services/commandResultHandlers.ts so the HTTP transport could dispatch them
 * too, taking the discovery and SNMP enqueues with them. The contract is about
 * the pipeline, not the file, so the scan covers both — otherwise moving a call
 * site out of agentWs.ts would silently drop it from the guard, and the HTTP
 * path runs these same handlers inside the request-long org context, where an
 * unwrapped enqueue has exactly the same cost.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  backupProcessResultSchema,
  backupSnapshotFileSchema,
  backupSnapshotSummarySchema,
} from '../jobs/queueSchemas';
import {
  backupSnapshotFileResultSchema,
  backupSnapshotResultSchema,
} from './backup/resultSchemas';

const source = readFileSync(path.join(__dirname, 'agentWs.ts'), 'utf8');
const handlerSource = readFileSync(
  path.join(__dirname, '..', 'services', 'commandResultHandlers.ts'),
  'utf8'
);

describe('agentWs enqueue context contract (#1105)', () => {
  it('every enqueue* call site is wrapped in runOutsideDbContext', () => {
    const scanned: Array<{ file: string; lines: string[] }> = [
      { file: 'agentWs.ts', lines: source.split('\n') },
      { file: 'services/commandResultHandlers.ts', lines: handlerSource.split('\n') },
    ];

    let total = 0;
    for (const { file, lines } of scanned) {
      const callSites: number[] = [];
      lines.forEach((line, idx) => {
        if (!/\benqueue[A-Z]\w*\s*\(/.test(line)) return;
        if (/^\s*import\b/.test(line) || /\bfrom '/.test(line) || /await import\(/.test(line)) return;
        callSites.push(idx);
      });
      total += callSites.length;

      for (const idx of callSites) {
        const window = lines.slice(Math.max(0, idx - 3), idx + 1).join('\n');
        expect(
          window.includes('runOutsideDbContext('),
          `enqueue call at ${file}:${idx + 1} must be wrapped in runOutsideDbContext (#1105):\n${lines[idx]}`
        ).toBe(true);
      }
    }

    // Known sites: monitor, SNMP (orphaned + tracked), discovery x2, backup,
    // DR reconcile — five now in agentWs.ts and two in the extracted handlers.
    // If the scan finds fewer, the regex rotted or a site moved to a third file
    // — fix the scan, don't delete the assertion.
    expect(total).toBeGreaterThanOrEqual(7);
  });
});

/**
 * Static contract (#3027): the backup `process-results` payload is built by a
 * HAND-MAINTAINED, key-by-key object literal in agentWs.ts. Every key the queue
 * schema declares has to appear in it, or that field is silently dropped on the
 * primary (Redis-up) path while every other test still passes.
 *
 * This is not hypothetical — it is how #3027 stayed hidden. `vssMetadata` could
 * be added to both zod schemas, persisted correctly, projected correctly, and
 * covered by tests at every individual hop, and STILL never reach the database,
 * because the one line that forwards it lives in a literal nothing asserts on.
 * Per-field tests cannot catch that class; only a completeness check can.
 *
 * Note the asymmetry that makes the literal the fragile half: the Redis-DOWN
 * branch a few lines below spreads `...(backupData ?? {})` and is structurally
 * immune to this failure.
 */
describe('agentWs backup enqueue payload completeness (#3027)', () => {
  // Keys legitimately absent from the literal, with the reason. Adding to this
  // set must be a deliberate, reviewed decision — that is the whole point.
  const NOT_IN_LITERAL = new Map<string, string>([
    ['jobId', 'passed as a positional argument to enqueueBackupResults, not inside the result object'],
  ]);

  it('forwards every key backupProcessResultSchema declares', () => {
    const start = source.indexOf('await runOutsideDbContext(() => enqueueBackupResults(');
    expect(start, 'the backup enqueue call site moved — fix this scan, do not delete it').toBeGreaterThan(-1);
    // Bound the window to the call, not the rest of the file, so an unrelated
    // mention of a key elsewhere cannot make this pass vacuously.
    const literal = source.slice(start, source.indexOf('Redis unavailable', start));
    expect(literal.length).toBeGreaterThan(0);

    const declaredKeys = Object.keys(backupProcessResultSchema.shape);
    // Sanity-check the introspection itself, so a zod API change turns this
    // into a failure rather than an empty, always-green loop.
    expect(declaredKeys).toContain('vssMetadata');
    expect(declaredKeys.length).toBeGreaterThanOrEqual(14);

    const missing = declaredKeys.filter(
      (key) => !NOT_IN_LITERAL.has(key) && !new RegExp(`\\b${key}\\s*:`).test(literal)
    );

    expect(
      missing,
      `agentWs.ts's enqueueBackupResults literal is missing ${missing.join(', ')} — ` +
        'those fields are declared on the queue schema but never forwarded, so they are ' +
        'silently dropped on the primary path (#3027).'
    ).toEqual([]);
  });
});

/**
 * Cross-layer schema parity (#5413, lesson (b)). The SAME agent payload shape is
 * validated twice: once at HTTP/WS ingress by routes/backup/resultSchemas.ts,
 * then again — by a separate, `.strict()` schema — at BullMQ enqueue time in
 * jobs/queueSchemas.ts. A field added to the ingress schema but not swept to the
 * queue schema passes ingress and is then rejected at the enqueue hop, which
 * drops the terminal result and leaves the job `running` forever.
 *
 * That exact miss shipped twice: July 2026, and again with `originalPath` (D12 /
 * #5413), where every VSS-backed Windows backup result was silently discarded.
 * Per-field tests on either side cannot catch it — only a key-set comparison can.
 *
 * Direction is deliberate: ingress ⊆ queue. Ingress is the superset the agent
 * actually sends; the queue schema must accept everything ingress accepts. The
 * queue schema may declare EXTRA keys (server-added ones, e.g. `agentStatus`),
 * so the reverse containment is not asserted.
 */
describe('backup result schema parity: route ingress ⊆ strict queue schema (#5413)', () => {
  // zod wraps a `.superRefine()`ed object in ZodEffects; reach the object to
  // read `.shape`. Returns [] rather than throwing so a zod API change shows up
  // as an explicit sanity-check failure below, not a cryptic one.
  const objectKeys = (schema: unknown): string[] => {
    const candidates = [schema, (schema as { _def?: { schema?: unknown } })?._def?.schema];
    for (const candidate of candidates) {
      const shape = (candidate as { shape?: Record<string, unknown> })?.shape;
      if (shape && typeof shape === 'object') return Object.keys(shape);
    }
    return [];
  };

  it('every snapshot-FILE key the route schema accepts is declared on the queue schema', () => {
    const routeKeys = objectKeys(backupSnapshotFileResultSchema);
    const queueKeys = objectKeys(backupSnapshotFileSchema);
    // Sanity-check the introspection so this cannot pass vacuously.
    expect(routeKeys).toContain('originalPath');
    expect(queueKeys).toContain('sourcePath');

    const missing = routeKeys.filter((key) => !queueKeys.includes(key));
    expect(
      missing,
      `jobs/queueSchemas.ts's backupSnapshotFileSchema is missing ${missing.join(', ')} — ` +
        'the strict queue schema will reject every result carrying those fields and the ' +
        'backup job will hang in `running` forever (#5413).'
    ).toEqual([]);
  });

  it('every SNAPSHOT-summary key the route schema accepts is declared on the queue schema', () => {
    const routeKeys = objectKeys(backupSnapshotResultSchema);
    const queueKeys = objectKeys(backupSnapshotSummarySchema);
    expect(routeKeys).toContain('baseSnapshotId');
    expect(queueKeys).toContain('files');

    const missing = routeKeys.filter((key) => !queueKeys.includes(key));
    expect(
      missing,
      `jobs/queueSchemas.ts's backupSnapshotSummarySchema is missing ${missing.join(', ')} (#5413).`
    ).toEqual([]);
  });
});
