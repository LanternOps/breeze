// e2e-tests/playwright/tests/agent-install.spec.ts
//
// The agent_install.yaml tests are primarily `remote` action tests that require
// live Windows/Linux/macOS agent nodes to download, install, and enroll the
// Breeze agent binary. Those steps cannot run in a headless browser-only
// Playwright context and are skipped here with an explanatory note.
//
// The one UI-accessible portion — navigating to Devices and opening the
// enrollment modal — is covered to ensure the enrollment UI renders correctly.
import { test, expect } from '../fixtures';
import { AgentInstallPage } from '../pages/AgentInstallPage';

test.describe('Agent Enrollment UI', () => {
  test('devices page loads (prerequisite for enrollment flows)', async ({ authedPage }) => {
    const page = new AgentInstallPage(authedPage);
    await page.gotoDevices();
    await expect(page.devicesHeading()).toBeVisible();
  });

  test('add device button opens enrollment modal', async ({ authedPage }) => {
    const page = new AgentInstallPage(authedPage);
    await page.gotoDevices();
    await page.openEnrollmentModal();
    await expect(page.enrollmentModalHeading()).toBeVisible();
  });

  test.skip(
    true,
    'agent_install_windows — requires live Windows node; install/enroll is not runnable in browser-only context',
  );

  test.skip(
    true,
    'agent_install_linux — requires live Linux node; install/enroll is not runnable in browser-only context',
  );

  test.skip(
    true,
    'agent_install_macos — requires live macOS node; install/enroll is not runnable in browser-only context',
  );
});
