import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('/auth tabs page', () => {
  test('renders both tabs', async ({ cleanPage }) => {
    const auth = new AuthPage(cleanPage);
    await auth.goto();
    await expect(auth.page_()).toBeVisible();
    await expect(auth.tabSignin()).toBeVisible();
    await expect(auth.tabSignup()).toBeVisible();
    await expect(auth.tabSignin()).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking Create account switches tab and updates the hash', async ({ cleanPage }) => {
    const auth = new AuthPage(cleanPage);
    await auth.goto();
    await auth.clickSignupTab();
    await expect(auth.tabSignup()).toHaveAttribute('aria-selected', 'true');
    expect(cleanPage.url()).toMatch(/#signup$/);
  });

  test('signing in via /auth honors ?next=', async ({ cleanPage }) => {
    const auth = new AuthPage(cleanPage);
    await auth.goto('/devices');
    await auth.signIn(
      process.env.E2E_ADMIN_EMAIL!,
      process.env.E2E_ADMIN_PASSWORD!,
      /\/devices(\?|$)|\/setup/,
    );
  });
});

test.describe('OAuth no-session redirect', () => {
  test('unauthenticated /oauth/consent redirects to /auth with next=', async ({ cleanPage }) => {
    // Use a fake uid — the API will 401 on the interaction lookup (no auth
    // cookies on cleanPage), and ConsentForm's 401 handler navigates to
    // /auth?next=... regardless of whether the uid is real.
    await cleanPage.goto('/oauth/consent?uid=fake-uid');
    await cleanPage.waitForURL(/\/auth\?next=/, { timeout: 30_000 });
    expect(decodeURIComponent(cleanPage.url())).toContain('/oauth/consent?uid=fake-uid');
  });
});
