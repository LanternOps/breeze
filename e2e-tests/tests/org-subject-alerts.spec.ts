import { test, expect } from '../fixtures';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const ALERT_ID = 'e2e10727-0000-4000-8000-000000000004';
function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const descriptor = process.env.E2E_STACK_FILE ?? path.resolve(directory, '../..', '.breeze-stack.json');
  if (existsSync(descriptor)) {
    const stack = JSON.parse(readFileSync(descriptor, 'utf8')) as { pgContainer?: string };
    if (stack.pgContainer) return stack.pgContainer;
  }
  return 'breeze-postgres';
}

test.describe('Org-subject alerts', () => {
  test.beforeAll(() => {
    execFileSync('docker', ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      input: readFileSync(path.resolve(directory, '../seed-org-subject-alerts.sql'), 'utf8'), encoding: 'utf8',
    });
  });

  test.beforeEach(async ({ authedPage }) => {
    // Avoid inheriting a different organization selected by an earlier spec.
    await authedPage.addInitScript(() => {
      const current = JSON.parse(localStorage.getItem('breeze-org') || '{}');
      localStorage.setItem('breeze-org', JSON.stringify({ ...current, state: {
        ...current.state, currentOrgId: null, allOrgs: true,
      } }));
    });
  });

  test('list shows a workload subject linking to backup health', async ({ authedPage }) => {
    await authedPage.goto('/alerts');
    const row = authedPage.getByTestId(`alert-row-${ALERT_ID}`);
    await expect(row).toBeVisible();
    const subject = row.getByTestId('alert-subject-chip');
    await expect(subject).toContainText('Microsoft 365 mail backup');
    await expect(subject).toHaveAttribute('href', '/backup#health');
    expect(await row.innerHTML()).not.toContain('href="/devices/');
  });

  test('detail shows its subject and has no device delegation action', async ({ authedPage }) => {
    await authedPage.goto(`/alerts/${ALERT_ID}`);
    const detail = authedPage.getByTestId('alert-detail-page');
    await expect(detail).toBeVisible();
    const subject = detail.getByTestId('alert-subject-chip');
    await expect(subject).toContainText('Microsoft 365 mail backup');
    await expect(subject).toHaveAttribute('href', '/backup#health');
    await expect(detail.getByTestId('alert-device-action')).toHaveCount(0);
    expect(await detail.innerHTML()).not.toContain('href="/devices/');
  });
});
