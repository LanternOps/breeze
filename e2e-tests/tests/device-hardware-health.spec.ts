import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { DeviceHardwarePage } from '../pages/DeviceHardwarePage';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const dirname = path.dirname(fileURLToPath(import.meta.url));
function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const file = process.env.E2E_STACK_FILE ?? path.resolve(dirname, '../..', '.breeze-stack.json');
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.pgContainer) return data.pgContainer;
  }
  return 'breeze-postgres';
}
function sql(statement: string): void {
  execFileSync('docker', ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze',
    '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8', input: `BEGIN; SELECT set_config('breeze.scope','system',true);\n${statement}\nCOMMIT;`,
  });
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Scenario = 'healthy' | 'degraded' | 'rebuilding' | 'stale' | 'no-tools' | 'disabled';
function seed(id: string, scenario: Scenario): void {
  const empty = scenario === 'no-tools' || scenario === 'disabled';
  const health = scenario === 'degraded' ? 'critical' : scenario === 'rebuilding' ? 'warning' : empty ? 'unknown' : 'ok';
  const state = scenario === 'degraded' ? 'degraded' : scenario === 'rebuilding' ? 'rebuilding' : 'optimal';
  const sources = empty ? [{ source: 'storcli', status: scenario === 'disabled' ? 'disabled' : 'unavailable' }]
    : [{ source: 'storcli', status: 'ok', complete: true, toolVersion: '7.4' },
      { source: 'megacli', status: 'superseded' }, { source: 'ssacli', status: 'unavailable' }];
  const tiers = scenario === 'disabled' ? 'disabled' : scenario === 'no-tools' ? 'none' : 'raid';
  sql(`
    INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status)
    SELECT ${literal(id)}::uuid,org_id,site_id,${literal(`e2e-hardware-${id}`)},
      ${literal(`e2e-hardware-${id}`)},'linux','test','amd64','0.117.0','offline'
    FROM devices WHERE id='e65460f3-413c-4599-a9a6-90ee71bbc4ff';
    INSERT INTO device_hardware (device_id,org_id,cpu_model)
      SELECT id,org_id,'E2E CPU' FROM devices WHERE id=${literal(id)}::uuid;
    INSERT INTO device_hardware_health (device_id,org_id,health,collector_health,summary,sources,
      last_collected_at,last_received_at,poll_interval_minutes,disk_health_interval_minutes,tiers_run)
    SELECT id,org_id,${literal(health)}::hardware_health,'ok',
      '{"counts":{"physical_disk:ok":1},"controllerNames":["E2E Controller"]}'::jsonb,${literal(JSON.stringify(sources))}::jsonb,
      now(),now(),10,60,ARRAY[${literal(tiers)}] FROM devices WHERE id=${literal(id)}::uuid;
  `);
  if (empty) return;
  sql(`
    INSERT INTO device_hardware_components
      (device_id,org_id,component_key,component_type,parent_key,source,name,model,serial,firmware,
       health,state,progress_percent,attributes,stale,stale_since,first_seen_at,last_seen_at)
    SELECT d.id,d.org_id,v.key,v.kind::hardware_component_type,v.parent,'storcli',v.name,v.model,v.serial,'1.0',
      v.health::hardware_health,v.state,v.progress,v.attrs::jsonb,v.stale,
      CASE WHEN v.stale THEN now()-interval '1 day' ELSE NULL END,now()-interval '2 days',
      CASE WHEN v.stale THEN now()-interval '1 day' ELSE now() END
    FROM devices d CROSS JOIN (VALUES
      ('storcli:c0','controller',NULL,'E2E Controller','H730P','CTRL-E2E','ok','ok',NULL::smallint,'{}',false),
      ('storcli:c0:v0','virtual_disk','storcli:c0','VD 0',NULL,NULL,${literal(health)},${literal(state)},
        ${scenario === 'rebuilding' ? '42' : 'NULL'}::smallint,'{"raidLevel":"RAID-1"}',false),
      ('storcli:c0:e1:s3','physical_disk','storcli:c0','Slot 3','Drive model','DISK-E2E','ok','online',NULL::smallint,
        '{"slot":3,"mediaType":"SSD","interface":"SAS","mediaErrors":0,"otherErrors":0}',${scenario === 'stale'})
    ) AS v(key,kind,parent,name,model,serial,health,state,progress,attrs,stale)
    WHERE d.id=${literal(id)}::uuid;
    INSERT INTO device_hardware_events
      (device_id,org_id,component_key,component_type,event_type,from_health,to_health,from_state,to_state,occurred_at)
    SELECT id,org_id,'storcli:c0:v0','virtual_disk','state_changed','ok',${literal(health)}::hardware_health,
      'optimal',${literal(state)},now() FROM devices WHERE id=${literal(id)}::uuid;
  `);
}
function cleanup(id: string): void {
  sql(`
    DELETE FROM device_hardware_events WHERE device_id=${literal(id)}::uuid;
    DELETE FROM device_hardware_components WHERE device_id=${literal(id)}::uuid;
    DELETE FROM device_hardware_health WHERE device_id=${literal(id)}::uuid;
    DELETE FROM device_hardware WHERE device_id=${literal(id)}::uuid;
    DELETE FROM devices WHERE id=${literal(id)}::uuid;
  `);
}
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);
for (const scenario of ['healthy', 'degraded', 'rebuilding', 'stale', 'no-tools', 'disabled'] as const) {
  test(`Storage & RAID: ${scenario}`, async ({ authedPage }) => {
    const id = randomUUID();
    try {
      seed(id, scenario);
      const hardware = new DeviceHardwarePage(authedPage);
      const read = authedPage.waitForResponse(response =>
        response.url().includes(`/devices/${id}/hardware-health`) && response.request().method() === 'GET');
      await hardware.goto(id);
      expect((await read).status()).toBe(200);
      await expect(hardware.section()).toBeVisible();
      await expect(authedPage).toHaveURL(/#hardware$/);
      if (scenario === 'no-tools' || scenario === 'disabled') {
        await expect(hardware.empty()).toContainText(scenario === 'disabled'
          ? 'disabled by policy' : 'No RAID or disk-health tooling detected');
        await expect(hardware.controllers()).toHaveCount(0);
      } else {
        await expect(hardware.controllers()).toHaveCount(1);
        await expect(hardware.controllers()).toContainText('DISK-E2E');
        await expect(hardware.rollup()).toHaveText(scenario === 'degraded' ? 'Critical'
          : scenario === 'rebuilding' ? 'Warning' : 'Healthy');
        if (scenario === 'rebuilding') await expect(hardware.progress('storcli:c0:v0')).toHaveAttribute('value', '42');
        if (scenario === 'stale') {
          await expect(hardware.disk('storcli:c0:e1:s3')).toHaveClass(/opacity-60/);
          await expect(hardware.disk('storcli:c0:e1:s3')).toContainText('Not seen since');
        }
        await expect(hardware.sources()).toContainText('Superseded by storcli');
        await expect(hardware.events()).not.toHaveAttribute('open', /.*/);
        await hardware.eventsToggle().click();
        await expect(hardware.events()).toHaveAttribute('open', /.*/);
        await expect(hardware.events()).toContainText('storcli:c0:v0');
      }
      await expect(hardware.sources()).toBeVisible();
    } finally { cleanup(id); }
  });
}
