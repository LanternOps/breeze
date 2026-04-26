// e2e-tests/playwright/tests/remote-session.spec.ts
// The remote_session.yaml tests are primarily `remote` action tests that require a
// live agent node (PTY sessions, file transfers, RDP). Those steps cannot be
// exercised in a pure browser context and are skipped here with an explanatory note.
// UI navigation steps that don't require an active agent are included.
import { test, expect } from '../fixtures';
import { RemoteSessionPage } from '../pages/RemoteSessionPage';

test.describe('Remote Session — UI navigation', () => {
  test('devices page loads (prerequisite for remote session flows)', async ({ authedPage }) => {
    const page = new RemoteSessionPage(authedPage);
    await page.gotoDevices();
    await expect(page.devicesHeading()).toBeVisible();
  });

  test.skip(
    true,
    'remote_terminal_session — requires live Linux agent with PTY; not runnable in browser-only context',
  );

  test.skip(
    true,
    'remote_file_transfer — requires live Linux agent; not runnable in browser-only context',
  );

  test.skip(
    true,
    'remote_session_windows — requires live Windows agent with RDP; not runnable in browser-only context',
  );
});
