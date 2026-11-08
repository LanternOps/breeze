/**
 * #11328 / #5241 / #10926 — every built-in alert must reach `alert.triggered`.
 *
 * Notification channels, routing rules, escalation, automations and AI
 * verdicts all hang off the `alert.triggered` event. A producer that writes
 * the `alerts` row itself and never publishes that event makes its alert
 * visible in the inbox and invisible to everything else, and the gap is
 * silent: nothing errors, the alert just never pages anyone. That shipped at
 * least four times (network monitors #5241, then log correlation, DNS threat,
 * AI fix-watch and AI act-verify alerts #11328).
 *
 * The shared path is `createAlert` (rule alerts) / `createSourcedAlert`
 * (rule-less alerts) in `services/alertService.ts`: they stage the event in the
 * same INSERT as the row and publish it after COMMIT. A new producer calls one
 * of them. A file that must write `alerts` directly is listed below with the
 * mechanism it uses to announce the alert, so the next reviewer can check it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'testUtils') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Production files that write `alerts` rows directly, and how each one gets
 * its alert to `alert.triggered`. Keep this list short: the answer for a new
 * producer is `createSourcedAlert`, not a new entry.
 */
const DIRECT_ALERT_WRITERS: Record<string, string> = {
  'services/alertService.ts': 'createAlert / createSourcedAlert: the shared path (outbox envelope, published after COMMIT)',
  'services/subjectAlertOutbox.ts': 'monitor recurrence escalation: stages its own `_subjectDispatch` envelope',
  'services/offlineAlertEffects.ts': 'offline alerts: durable `alert-event` effect publishes after admission',
  'services/topology/monitoringAlerts.ts': 'topology site alerts: publishes `alert.triggered` for committed transitions',
  'services/networkIsolation/outcome.ts': 'isolation outcome alert: publishes `alert.triggered` from runAfterDbContextCommit',
  'services/alertCreation.ts': 'automation / flow create_alert action: publishes `alert.triggered` itself',
  'services/metricAnomalyPromotion.ts': 'metric anomaly promotion: publishes `alert.triggered` itself',
  'services/llm/researchEval/runCase.ts': 'research-eval fixture seeding, not a producer',
  'db/seedE2eFixtures.ts': 'E2E seed fixtures, not a producer',
};

// `insert(alerts)` and a namespaced `insert(schema.alerts)`, plus raw SQL.
const ALERT_WRITE = /\.insert\s*\(\s*(?:\w+\.)?alerts\s*\)|INSERT\s+INTO\s+(?:public\.)?alerts\b/i;

/** Line comments and block comments, so a comment that mentions a raw insert does not count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function directWriters(): string[] {
  return productionFiles(src)
    .filter((path) => ALERT_WRITE.test(stripComments(readFileSync(path, 'utf8'))))
    .map((path) => relative(src, path).split('\\').join('/'))
    .sort();
}

describe('alert.triggered writer contract', () => {
  it('only the listed files write alerts rows directly; every other producer uses createAlert / createSourcedAlert', () => {
    const unexpected = directWriters().filter((path) => !(path in DIRECT_ALERT_WRITERS));
    expect(
      unexpected,
      'These files insert into `alerts` without going through createAlert/createSourcedAlert, so their alerts '
        + 'never publish alert.triggered (no notifications, routing or escalation). Use createSourcedAlert.',
    ).toEqual([]);
  });

  it('has no stale entries (a listed file that no longer writes alerts must be removed)', () => {
    const writers = new Set(directWriters());
    const stale = Object.keys(DIRECT_ALERT_WRITERS).filter((path) => !writers.has(path));
    expect(stale).toEqual([]);
  });

  it('ignores a raw insert that only appears in a comment', () => {
    expect(ALERT_WRITE.test(stripComments('// a raw `db.insert(alerts)` here never published\nconst x = 1;'))).toBe(false);
    expect(ALERT_WRITE.test(stripComments('/* INSERT INTO alerts (...) */ const x = 1;'))).toBe(false);
    expect(ALERT_WRITE.test(stripComments('await db.insert(alerts).values(row);'))).toBe(true);
    expect(ALERT_WRITE.test(stripComments('await tx.insert(schema.alerts).values(row);'))).toBe(true);
    expect(ALERT_WRITE.test(stripComments('await db.insert(alertRules).values(row);'))).toBe(false);
  });
});
