import { test, expect } from '../fixtures';
import { waitForHydration } from '../pages/hydration';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';
import { clearRefreshState } from '../test-helpers';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Trust Center W3d (#8771): a customer org admin edits the trust page draft in
 * the portal, the MSP sees and publishes it, the customer withdraws it.
 *
 * The seeded portal login (portal@breeze.local) has no contact, and no API links
 * an ACTIVE login to one (the invite path refuses active accounts), so the spec
 * links it to a contact holding the org-scoped `admin` responsibility through
 * the stack's Postgres (precedent: ai-script-proposals.spec.ts). Everything else
 * goes through the UI: the MSP turns the flag on in Settings → Customer Portal.
 * The seeded admin's JWT carries `mfa: true`, so the MFA-gated routes need no
 * step-up (same as trust-center.spec.ts).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portalEmail = process.env.E2E_PORTAL_EMAIL ?? 'portal@breeze.local';
const portalPassword = process.env.E2E_PORTAL_PASSWORD ?? 'PortalTest123!';

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

/** Idempotent: link the seeded login to a contact and give that contact the org-wide admin role. Returns the org id. */
function makePortalUserAnOrgAdmin(): { orgId: string; orgName: string } {
  // Forced RLS: elect system scope for this session's writes (seed-fixtures.sql does the same).
  const out = psql(`
    SELECT set_config('breeze.scope', 'system', false);
    DO $$
    DECLARE v_pu uuid; v_org uuid; v_contact uuid;
    BEGIN
      SELECT id, org_id, contact_id INTO v_pu, v_org, v_contact FROM portal_users WHERE email = '${portalEmail}' ORDER BY created_at LIMIT 1;
      IF v_contact IS NULL THEN
        SELECT id INTO v_contact FROM contacts WHERE org_id = v_org AND lower(email) = '${portalEmail}' LIMIT 1;
        IF v_contact IS NULL THEN
          INSERT INTO contacts (org_id, name, email) VALUES (v_org, 'E2E Portal Customer', '${portalEmail}') RETURNING id INTO v_contact;
        END IF;
        UPDATE portal_users SET contact_id = v_contact WHERE id = v_pu;
      END IF;
      INSERT INTO contact_roles (contact_id, org_id, role) VALUES (v_contact, v_org, 'admin') ON CONFLICT DO NOTHING;
    END $$;
    SELECT o.id || '|' || o.name FROM portal_users pu JOIN organizations o ON o.id = pu.org_id WHERE pu.email = '${portalEmail}' ORDER BY pu.created_at LIMIT 1;
  `);
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l.includes('|')).pop()!;
  const [orgId, ...name] = line.split('|');
  return { orgId: orgId!, orgName: name.join('|') };
}

async function mspPublish(page: Page) {
  await page.getByTestId('trust-publish').click();
  const change = page.getByTestId('trust-publish-change');
  if (await change.isVisible()) await change.click();
  await page.getByTestId('trust-publish-authorized-checkbox').check();
  await page.getByTestId('trust-publish-authorized-by').fill('E2E Approver, CTO');
  await page.getByTestId('trust-publish-confirm').click();
  await expect(page.getByTestId('trust-unpublish')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(clearRefreshState);
test.describe.configure({ timeout: 240_000 });

test('customer admin edits the draft, MSP publishes it, customer withdraws it', async ({ authedPage: msp, cleanPage: customer, browser, baseURL }) => {
  const { orgId, orgName } = makePortalUserAnOrgAdmin();

  // 1. The MSP turns customer trust page editing on (Settings → Customer Portal).
  await msp.goto(`/settings/organizations/${orgId}#portal`);
  const toggle = msp.getByTestId('org-portal-toggle-enableTrustPageEditing');
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await msp.getByTestId('org-portal-save').click();
    await expect(msp.getByText('Portal settings saved').first()).toBeVisible({ timeout: 30_000 });
  }

  // 2. The MSP has a published page (unpublish first if an earlier run left it live, then publish fresh).
  await msp.goto(`/organizations/${orgId}#trust`);
  await expect(msp.getByTestId('trust-publish')).toBeVisible({ timeout: 60_000 });
  if (await msp.getByTestId('trust-unpublish').isVisible()) {
    await msp.getByTestId('trust-unpublish').click();
    await msp.getByTestId('trust-unpublish-confirm').click();
    await expect(msp.getByTestId('trust-unpublish')).toBeHidden({ timeout: 30_000 });
  }
  await mspPublish(msp);
  const shown = (await msp.getByTestId('trust-public-url').textContent())!.trim();
  const publicUrl = new URL(new URL(shown, baseURL).pathname, baseURL).toString();

  // 3. The customer admin edits the security contact email in the portal.
  const newEmail = `security-${Date.now()}@example.com`;
  await new PortalVisibilityPage(customer).login(portalEmail, portalPassword);
  await customer.goto('/portal/security/trust-page');
  await waitForHydration(customer, 'trust-editor-save');
  await expect(customer.getByText(/Your provider publishes your changes/)).toBeVisible();
  await expect(customer.getByRole('button', { name: /^publish/i })).toHaveCount(0);
  await customer.getByTestId('trust-editor-email').fill(newEmail);
  await customer.getByTestId('trust-editor-save').click();
  await expect(customer.getByTestId('trust-editor-saved')).toBeVisible({ timeout: 30_000 });

  // 4. The MSP's reloaded editor shows the customer's draft value, and a publish at the fresh revision succeeds.
  // Same URL + hash: goto would be a same-document navigation, so reload to refetch the draft.
  await msp.reload();
  await expect(msp.getByTestId('trust-content-contact')).toHaveValue(newEmail, { timeout: 60_000 });
  await mspPublish(msp);

  // 5. The customer withdraws the page; the public URL stops serving.
  await customer.reload();
  await waitForHydration(customer, 'trust-editor-unpublish');
  await customer.getByTestId('trust-editor-unpublish').click();
  await customer.getByTestId('trust-editor-unpublish-name').fill(orgName);
  await customer.getByTestId('trust-editor-unpublish-confirm').click();
  await expect(customer.getByTestId('trust-editor-withdrawn')).toBeVisible({ timeout: 30_000 });

  const anon = await browser.newContext();
  try {
    const gone = await anon.newPage();
    const res = await gone.goto(publicUrl);
    expect(res?.status()).toBe(404);
  } finally {
    await anon.close();
  }
});
