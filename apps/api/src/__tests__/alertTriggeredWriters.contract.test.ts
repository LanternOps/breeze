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
 *
 * #11348 / #10926 — and the event must go out only after the row is visible.
 * A `publishEvent('alert.triggered', …)` inside the writing transaction runs
 * the `process-alert` consumer against a row another connection cannot see
 * yet, and the notification is dropped. So a file that publishes the event
 * itself is listed too, with how it waits for COMMIT.
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
  'services/alertCreation.ts': 'automation / flow create_alert action: stages the outbox envelope itself (it needs its synthetic rule id and a per-alert subject key)',
  'services/llm/researchEval/runCase.ts': 'research-eval fixture seeding, not a producer',
  'db/seedE2eFixtures.ts': 'E2E seed fixtures, not a producer',
};

/**
 * Production files that call `publishEvent('alert.triggered', …)` themselves,
 * and how each one waits until the alert row has committed. The outbox
 * (`subjectAlertOutbox.ts`) publishes the staged envelope's own `eventType`,
 * so it is not a literal match and not listed. The answer for a new producer
 * is the outbox, not a new entry.
 */
const INLINE_TRIGGER_PUBLISHERS: Record<string, string> = {
  'services/offlineTransitionEffects.ts': 'durable `alert-event` effect, processed after the admission transaction commits',
  'services/topology/monitoringAlerts.ts': 'drains its own committed transition outbox (topology_change_outbox)',
  'services/networkIsolation/outcome.ts': 'runAfterDbContextCommit',
};

// `publishEvent('alert.triggered'`, `bus.publish("alert.triggered"`, and the
// `EVENT_TYPES.ALERT_TRIGGERED` constant, with the arguments on later lines.
const TRIGGER_PUBLISH = /\b(?:publishEvent|publish)\s*(?:<[^>]*>)?\s*\(\s*(?:(['"`])alert\.triggered\1|EVENT_TYPES\.ALERT_TRIGGERED\b)/;

// `insert(alerts)` and a namespaced `insert(schema.alerts)`, plus raw SQL.
const ALERT_WRITE = /\.insert\s*\(\s*(?:\w+\.)?alerts\s*\)|INSERT\s+INTO\s+(?:public\.)?alerts\b/i;

/** Line comments and block comments, so a comment that mentions a raw insert does not count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function filesMatching(pattern: RegExp): string[] {
  return productionFiles(src)
    .filter((path) => pattern.test(stripComments(readFileSync(path, 'utf8'))))
    .map((path) => relative(src, path).split('\\').join('/'))
    .sort();
}

const directWriters = () => filesMatching(ALERT_WRITE);
const triggerPublishers = () => filesMatching(TRIGGER_PUBLISH);

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

  it('only the listed files publish alert.triggered themselves; every other producer stages it for the outbox', () => {
    const unexpected = triggerPublishers().filter((path) => !(path in INLINE_TRIGGER_PUBLISHERS));
    expect(
      unexpected,
      'These files publish alert.triggered directly. Inside the writing transaction that reaches process-alert '
        + 'before the row is visible and the notification is dropped (#10926). Use createAlert/createSourcedAlert, '
        + 'or stage the outbox envelope with stagedTriggerDispatch + scheduleStagedAlertDispatch.',
    ).toEqual([]);
  });

  it('has no stale inline publisher entries', () => {
    const publishers = new Set(triggerPublishers());
    const stale = Object.keys(INLINE_TRIGGER_PUBLISHERS).filter((path) => !publishers.has(path));
    expect(stale).toEqual([]);
  });

  it('recognises an alert.triggered publish however it is spelled, and nothing else', () => {
    const hits = (source: string) => TRIGGER_PUBLISH.test(stripComments(source));
    expect(hits("await publishEvent('alert.triggered', orgId, payload, 'x');")).toBe(true);
    expect(hits('await publishEvent(\n    "alert.triggered",\n    orgId,\n  );')).toBe(true);
    expect(hits('await getEventBus().publish(`alert.triggered`, orgId, payload, source);')).toBe(true);
    expect(hits('await publishEvent<Payload>(EVENT_TYPES.ALERT_TRIGGERED, orgId, payload, source);')).toBe(true);
    expect(hits("await publishEvent('alert.resolved', orgId, payload, 'x');")).toBe(false);
    expect(hits("eventTypes: ['alert.triggered', 'alert.resolved'],")).toBe(false);
    expect(hits("// publishEvent('alert.triggered', …) used to run here\nconst x = 1;")).toBe(false);
  });
});
