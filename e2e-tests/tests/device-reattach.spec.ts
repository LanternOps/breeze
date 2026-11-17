/**
 * Reattach a reinstalled machine (#8318 wave 2-3): the device page's
 * possible-replacement banner → the reattach dialog → confirm → pending, and
 * the "Reinstalled on <date>" badge.
 *
 * The two device rows are real (seeded through psql, as
 * device-hardware-health.spec.ts does), so the device page, the banner's read
 * of the old row and the public `lastReattachedAt` field run end to end.
 *
 * The candidates read and the reattach POST are fulfilled in the browser
 * (page.route, as autopay-processing-fees.spec.ts does). A real request needs
 * what a seeded stack does not have: an MFA-satisfied session (the seeded
 * admin signs in password-only, so `requireMfa` answers 403 MFA_REQUIRED), a
 * source agent speaking the rebind protocol, and Redis liveness signals for
 * the target. The API side of both routes, every refusal and the step-up are
 * covered against real PostgreSQL and Redis by
 * apps/api/src/__tests__/integration/deviceReattachRoute.integration.test.ts.
 */
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { DeviceReattachPage } from '../pages/DeviceReattachPage';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirname = path.dirname(fileURLToPath(import.meta.url));
/** The seeded Windows device (seed-fixtures.sql); new rows copy its org and site. */
const SEEDED_DEVICE_ID = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';

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

/** A device row in the seeded device's org and site. */
function insertDevice(id: string, hostname: string, extra: { columns: string; values: string } = { columns: '', values: '' }): void {
  sql(`
    INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status${extra.columns})
    SELECT ${literal(id)}::uuid,org_id,site_id,${literal(`e2e-reattach-${id}`)},${literal(hostname)},
      'windows','11','amd64','0.120.0','offline'${extra.values}
    FROM devices WHERE id=${literal(SEEDED_DEVICE_ID)};
  `);
}

function orgOf(id: string): string {
  return execFileSync('docker', ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-At',
    '-c', `SELECT org_id FROM devices WHERE id=${literal(id)}`], { encoding: 'utf8' }).trim();
}

function cleanup(ids: string[]): void {
  sql(`
    UPDATE devices SET possible_replacement_of_device_id=NULL,possible_replacement_reason=NULL,
      possible_replacement_detected_at=NULL WHERE id IN (${ids.map((id) => `${literal(id)}::uuid`).join(',')});
    DELETE FROM devices WHERE id IN (${ids.map((id) => `${literal(id)}::uuid`).join(',')});
  `);
}

/** The comparison fields of one side, as GET /devices/:id/reinstall-candidates returns them. */
function side(hostname: string, extra: Record<string, unknown> = {}) {
  return {
    hostname, displayName: null, osType: 'windows', osVersion: '11', agentVersion: '0.120.0', status: 'offline',
    enrolledAt: '2026-11-10T10:00:00.000Z', createdAt: '2026-11-10T10:00:00.000Z', lastSeenAt: null,
    decommissionedAt: null, serialNumber: 'E2E-SERIAL', manufacturer: 'E2E', model: 'Reattach', systemUuid: 'e2e-uuid',
    ...extra,
  };
}

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test('possible-replacement banner → reattach dialog → confirm → pending', async ({ authedPage: page }) => {
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const oldName = `E2E-REATTACH-OLD-${targetId.slice(0, 8)}`;
  const newName = `E2E-REATTACH-NEW-${sourceId.slice(0, 8)}`;
  try {
    insertDevice(targetId, oldName);
    insertDevice(sourceId, newName, {
      columns: ',possible_replacement_of_device_id,possible_replacement_reason,possible_replacement_detected_at',
      values: `,${literal(targetId)}::uuid,'hardware',now()`,
    });
    const orgId = orgOf(targetId);
    const targetVersion = 'e2e'.padEnd(43, 'x');
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const candidate = {
      deviceId: targetId, orgId, orgName: 'E2E Org', siteId: randomUUID(), siteName: 'E2E Site',
      ...side(oldName, { enrolledAt: '2025-01-01T10:00:00.000Z' }),
      evidence: 'system_uuid', reason: 'hardware', evidenceLevel: 'hint', flagged: true,
      osChanged: false, requiresRestore: false, targetVersion,
    };
    let requested: Record<string, unknown> | null = null;
    await page.route(new RegExp(`/api/v1/devices/${sourceId}/reinstall-candidates$`), async (route) => {
      await route.fulfill({
        json: {
          source: { deviceId: sourceId, parked: false, rebindSupported: true, ...side(newName) },
          candidates: [candidate],
          reviewPending: false,
          openIntent: requested
            ? { intentId: 'e2e-intent', state: 'requested', targetDeviceId: targetId, expiresAt }
            : null,
          evidenceNotice: 'Hardware identifiers reported by the device. Not verified.',
        },
      });
    });
    await page.route(new RegExp(`/api/v1/devices/${sourceId}/reattach$`), async (route) => {
      requested = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        json: {
          intent: {
            id: 'e2e-intent', state: 'requested', sourceDeviceId: sourceId, targetDeviceId: targetId,
            evidenceLevel: 'hint', restoreDecommissioned: false,
            requestedAt: new Date().toISOString(), expiresAt,
          },
        },
      });
    });

    const reattach = new DeviceReattachPage(page);
    await reattach.goto(sourceId);
    await expect(reattach.banner()).toBeVisible();
    await reattach.reattachButton().click();

    await expect(reattach.dialog()).toBeVisible();
    await expect(reattach.compareTarget('hostname')).toHaveText(oldName);
    await expect(reattach.evidenceNotice()).toHaveText('Hardware identifiers reported by the device. Not verified.');
    await expect(reattach.consequences()).toContainText('Queued work, grants and sessions of the old install are cancelled');

    await expect(reattach.submit()).toBeDisabled();
    await reattach.possession().check();
    await reattach.confirmName().fill(oldName.toLowerCase());
    await expect(reattach.submit()).toBeEnabled();
    await reattach.submit().click();

    await expect(reattach.pending()).toBeVisible();
    expect(requested).toEqual({
      targetDeviceId: targetId,
      targetVersion,
      possessionConfirmed: true,
      confirmTargetName: oldName.toLowerCase(),
      restoreDecommissioned: false,
      acknowledgeOsChange: false,
    });
    await reattach.done().click();
    await expect(reattach.dialog()).toHaveCount(0);
    await expect(reattach.bannerPending()).toBeVisible();
    await expect(reattach.reattachButton()).toHaveCount(0);
  } finally {
    cleanup([sourceId, targetId]);
  }
});

test('a reattached record shows the Reinstalled badge', async ({ authedPage: page }) => {
  const id = randomUUID();
  try {
    insertDevice(id, `E2E-REINSTALLED-${id.slice(0, 8)}`, {
      columns: ',install_incarnation,incarnation_started_at,last_reattached_at',
      values: ",2,now(),now()",
    });
    const reattach = new DeviceReattachPage(page);
    await reattach.goto(id);
    await expect(reattach.reinstalledBadge()).toBeVisible();
    await expect(reattach.reinstalledBadge()).toContainText('Reinstalled on');
  } finally {
    cleanup([id]);
  }
});
