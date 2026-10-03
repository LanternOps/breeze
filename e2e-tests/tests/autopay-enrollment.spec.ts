import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';
import { test, expect } from '../fixtures';
import { AutopayEnrollmentPage } from '../pages/AutopayEnrollmentPage';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixtureSql(sql: string): string {
  const descriptor = JSON.parse(readFileSync(process.env.E2E_STACK_FILE ?? path.join(root, '.breeze-stack.json'), 'utf8')) as { project: string };
  return execFileSync('docker', ['compose', '-p', descriptor.project, '--env-file', '.env', '--env-file', '.env.stack',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree',
    'exec', '-T', 'postgres', 'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'breeze', '-d', 'breeze'],
    { cwd: root, input: `BEGIN; SELECT set_config('breeze.scope','system',true); ${sql} COMMIT;`, encoding: 'utf8' }).trim().split('\n').at(-1)!;
}
test.describe.configure({ mode: 'serial' });

const orgId = '11111111-1111-4111-8111-111111111111';
const disclosure = { text: 'I authorize Example MSP to collect new invoices under the stated schedule.', hash: 'a'.repeat(64), feeText: 'Bank account: no fee. Credit card: no fee. Debit card: no fee.' };
const setup = { partnerName: 'Example MSP', logoUrl: null, scheduleText: 'On the later of issue date or due date.', achMode: 'ach_preferred',
  enrollment: { status: 'requested' }, method: null, disclosures: { card: disclosure, us_bank_account: disclosure } };
test('bulk requests, unasked banner and skipped-recipient feedback', async ({ authedPage }) => {
  await authedPage.route(/\/api\/v1\/billing\/autopay(\?.*)?$/, route => route.fulfill({ json: { data: [{ orgId, orgName: 'Example client', billingContact: null,
    status: 'not_requested', enrollment: null, method: null }], notRequestedCount: 1 } }));
  await authedPage.route(/\/api\/v1\/billing\/autopay\/requests(\?.*)?$/, route => route.fulfill({ json: { requested: [], skipped: [{ orgId, reason: 'no_billing_contact' }] } }));
  const page = new AutopayEnrollmentPage(authedPage); await page.openList();
  await expect(page.unasked()).toBeVisible(); await page.sendNow().click();
  await expect(page.bulkResult()).toContainText('No billing contact email is available. Add an email or enter a recipient.');
  await expect(page.bulkResult()).not.toContainText('no_billing_contact');
});
test('ACH-preferred is selected, fees visible, and explicit authorization required', async ({ cleanPage }) => {
  await cleanPage.route('**/api/v1/autopay/public/test-token', route => route.fulfill({ json: setup }));
  const page = new AutopayEnrollmentPage(cleanPage); await page.openSetup();
  await expect(page.bank()).toBeChecked(); await expect(page.bankFee()).toContainText('no fee');
  await expect(page.continueSetup()).toBeDisabled(); await page.consent().check();
  await expect(page.continueSetup()).toBeEnabled(); await page.card().check();
  await expect(page.consent()).not.toBeChecked();
});
test('ACH-only never offers card and stop page GET never submits', async ({ cleanPage }) => {
  await cleanPage.route('**/api/v1/autopay/public/test-token', route => route.fulfill({ json: { ...setup, achMode: 'ach_only' } }));
  let posts = 0;
  await cleanPage.route('**/api/v1/autopay/public/stop-token/stop', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: { partnerName: 'Example MSP', orgName: 'Example client', processingWarning: true, success: true } });
  });
  const page = new AutopayEnrollmentPage(cleanPage); await page.openSetup(); await expect(page.card()).toHaveCount(0);
  await page.openStop(); await expect(page.stopConfirm()).toBeVisible(); expect(posts).toBe(0);
  await page.stop().click(); await expect(page.feedback()).toContainText('stopped'); expect(posts).toBe(1);
});
test('Payments hash mounts inheritance without a second save action', async ({ authedPage }) => {
  const inherited = { autopayOffsetDays: { value: 7, source: 'partner' }, autopayOffsetRule: { value: 'later', source: 'partner' },
    autopayCap: { value: { enabled: false }, source: 'partner' }, achMode: { value: 'ach_preferred', source: 'partner' } };
  await authedPage.route(/\/api\/v1\/partner\/billing\/payment-settings(\?.*)?$/, route => route.fulfill({ json: { autopayEnabled: true,
    values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null }, inherited, effective: inherited } }));
  const page = new AutopayEnrollmentPage(authedPage); await page.openPayments();
  await expect(page.settings()).toBeVisible(); await expect(page.offset()).toHaveAttribute('placeholder', '7');
  await expect(authedPage.getByTestId('partner-billing-save')).toHaveCount(0);
});

test('authenticated portal mounts Payment methods and its navigation', async ({ cleanPage }) => {
  const where = "id IN (SELECT o.partner_id FROM organizations o JOIN portal_users u ON u.org_id=o.id WHERE u.email='portal@breeze.local')";
  const previous = fixtureSql(`SELECT autopay_enabled FROM partners WHERE ${where};`);
  expect(['t', 'f']).toContain(previous);
  fixtureSql(`UPDATE partners SET autopay_enabled=true WHERE ${where};`);
  try {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login('portal@breeze.local', 'PortalTest123!');
    await cleanPage.goto('/portal/payment-methods');
    await expect(cleanPage.getByTestId('autopay-payment-methods')).toBeVisible();
    await expect(cleanPage.getByTestId('autopay-nav-payment-methods')).toBeVisible();
  } finally { fixtureSql(`UPDATE partners SET autopay_enabled=${previous === 't' ? 'true' : 'false'} WHERE ${where};`); }
});
