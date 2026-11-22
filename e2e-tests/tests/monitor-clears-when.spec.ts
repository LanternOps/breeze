import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../fixtures';

/**
 * The UPS story from #10538, on the real alert worker: authored in the editor,
 * then driven by event rows. Slow on purpose: the sweep ticks every 60 s and
 * auto-resolve every 2 min, and neither is sped up here.
 */
const directory = path.dirname(fileURLToPath(import.meta.url));
const SEED_DEVICE = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';
const SOURCE = 'APCPBEAgent';

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const file = process.env.E2E_STACK_FILE ?? path.resolve(directory, '../..', '.breeze-stack.json');
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { pgContainer?: string };
    if (data.pgContainer) return data.pgContainer;
  }
  return 'breeze-postgres';
}

function write(statement: string): void {
  execFileSync('docker', ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8',
    input: `BEGIN; SELECT set_config('breeze.scope','system',true);\n${statement}\nCOMMIT;`,
  });
}

function read(query: string): string {
  return execFileSync('docker', ['exec', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8',
  }).trim();
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

test.describe('Monitor "Clears when"', () => {
  test('an event_log monitor clears on its recovery event and only re-opens on new evidence', async ({ authedPage: page }) => {
    test.setTimeout(15 * 60 * 1000);

    const deviceId = randomUUID();
    const name = `E2E UPS on battery ${deviceId.slice(0, 8)}`;
    let recordId = 1000;

    // The sweep only selects online devices seen in the last 5 minutes.
    const keepOnline = () => write(`UPDATE devices SET status='online', last_seen_at=now() WHERE id=${literal(deviceId)}::uuid;`);
    const logEvent = (level: 'warning' | 'info', message: string) => {
      recordId += 1;
      write(`
        INSERT INTO device_event_logs (device_id, org_id, timestamp, level, category, source, event_id, message, details)
        SELECT id, org_id, now(), ${literal(level)}, 'application', ${literal(SOURCE)}, ${literal(String(recordId))}, ${literal(message)},
          ${literal(JSON.stringify({ logName: 'Application', recordId }))}::jsonb
        FROM devices WHERE id=${literal(deviceId)}::uuid;
      `);
    };
    const alerts = () => read(`SELECT status FROM alerts WHERE device_id=${literal(deviceId)}::uuid ORDER BY triggered_at`)
      .split('\n').filter(Boolean);
    const waitForAlerts = (expected: string[], timeout: number) =>
      expect.poll(() => { keepOnline(); return alerts(); }, { timeout, intervals: [5000] }).toEqual(expected);

    write(`
      INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, last_seen_at)
      SELECT ${literal(deviceId)}::uuid, org_id, site_id, ${literal(`e2e-clears-${deviceId}`)}, ${literal(`e2e-clears-${deviceId.slice(0, 8)}`)},
        'windows', 'test', 'amd64', '0.126.0', 'online', now()
      FROM devices WHERE id=${literal(SEED_DEVICE)}::uuid;
    `);

    // Author it in the editor.
    await page.goto('/alerts/monitors/new#kind=event_log');
    await page.getByTestId('monitor-editor-name').fill(name);
    await page.getByTestId('condition-field-level').selectOption('warning');
    await page.getByTestId('condition-field-sourcePattern').fill(SOURCE);
    await page.getByTestId('condition-field-messagePattern').fill('On Battery');
    await page.getByTestId('monitor-editor-cooldown').fill('0');

    await expect(page.getByTestId('monitor-editor-clears-when')).toHaveCount(0);
    await page.getByTestId('monitor-editor-auto-resolve').selectOption('true');
    await expect(page.getByTestId('monitor-editor-clears-when')).toBeVisible();

    await page.getByTestId('clears-when-add').click();
    await expect(page.getByTestId('clears-when-source')).toHaveValue(SOURCE);
    await expect(page.getByTestId('clears-when-level')).toHaveValue('info');
    await page.getByTestId('clears-when-message').fill('Power Restored');

    await page.getByTestId('monitor-editor-save').click();
    await page.waitForURL(/\/alerts\/monitors\/[0-9a-f-]{36}/);

    const monitorId = read(`SELECT id FROM monitor_definitions WHERE name=${literal(name)}`);
    expect(monitorId).toMatch(/^[0-9a-f-]{36}$/);
    // The compiled template carries the discriminant the evaluator reads (the C3 bug).
    expect(read(`SELECT auto_resolve_conditions->>'type' FROM alert_templates WHERE managed_by_monitor_id=${literal(monitorId)}::uuid`))
      .toBe('event_log');

    // The editor reads back what it saved.
    await page.reload();
    await expect(page.getByTestId('clears-when-message')).toHaveValue('Power Restored');

    // A policy puts the monitor on just this device.
    const policyId = randomUUID();
    const linkId = randomUUID();
    write(`
      INSERT INTO configuration_policies (id, org_id, name, status)
      SELECT ${literal(policyId)}::uuid, org_id, ${literal(`E2E policy ${deviceId.slice(0, 8)}`)}, 'active'
      FROM devices WHERE id=${literal(deviceId)}::uuid;
      INSERT INTO config_policy_feature_links (id, config_policy_id, feature_type)
      VALUES (${literal(linkId)}::uuid, ${literal(policyId)}::uuid, 'monitors');
      INSERT INTO config_policy_monitors (feature_link_id, monitor_id)
      VALUES (${literal(linkId)}::uuid, ${literal(monitorId)}::uuid);
      INSERT INTO config_policy_assignments (config_policy_id, level, target_id, priority)
      VALUES (${literal(policyId)}::uuid, 'device', ${literal(deviceId)}::uuid, 0);
    `);

    // On Battery opens an alert.
    logEvent('warning', 'UPS On Battery');
    await waitForAlerts(['active'], 4 * 60 * 1000);

    // Its detail page says how it re-arms, from the snapshot it opened with.
    const alertId = read(`SELECT id FROM alerts WHERE device_id=${literal(deviceId)}::uuid`);
    await page.goto(`/alerts/${alertId}`);
    await expect(page.getByTestId('alert-lifecycle-line')).toHaveText('Re-arms on new evidence · cooldown 0 min (this monitor)');

    // Power Restored clears it, with the trigger event still in its window.
    logEvent('info', 'UPS Power Restored');
    await waitForAlerts(['resolved'], 5 * 60 * 1000);

    // Past the cooldown (0 min) and across more than two sweeps, the consumed trigger does not re-open it.
    const pastCooldown = Date.now() + 150 * 1000;
    await expect.poll(() => { keepOnline(); return Date.now() > pastCooldown; }, { timeout: 200 * 1000, intervals: [5000] }).toBe(true);
    expect(alerts()).toEqual(['resolved']);

    // Control: the sweep above was really running, because new evidence does re-open it.
    logEvent('warning', 'UPS On Battery');
    await waitForAlerts(['resolved', 'active'], 4 * 60 * 1000);
  });
});
