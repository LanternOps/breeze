import { expect, test } from '../fixtures';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';
import { PortalHardwareLifecyclePage } from '../pages/PortalHardwareLifecyclePage';

const email = process.env.E2E_PORTAL_EMAIL ?? 'portal@breeze.local';
const password = process.env.E2E_PORTAL_PASSWORD ?? 'PortalTest123!';

// First-run generation is synchronous on the API side but slow in a dev-mode
// stack (Astro compiles each portal page on first request too), matching
// portal-visibility.spec.ts's convention for the same reason.
test.describe.configure({ timeout: 90_000 });

test.describe.serial('portal hardware lifecycle', () => {
  test('reaches the lifecycle page from the Reports card and renders a run', async ({
    cleanPage,
  }) => {
    const login = new PortalVisibilityPage(cleanPage);
    await login.login(email, password);

    const lifecycle = new PortalHardwareLifecyclePage(cleanPage);
    await lifecycle.gotoReports();
    await expect(lifecycle.lifecycleCard()).toBeVisible();
    await lifecycle.openLifecycle();

    await lifecycle.refreshAndWaitForRun();

    await expect(lifecycle.statusBar()).toBeVisible();
    await expect(lifecycle.schedule()).toBeVisible();
    await expect(lifecycle.planTable('workstations')).toBeVisible();
  });

  test('shows a quarter label on hover and a working device row link', async ({
    cleanPage,
  }) => {
    const login = new PortalVisibilityPage(cleanPage);
    await login.login(email, password);

    const lifecycle = new PortalHardwareLifecyclePage(cleanPage);
    await lifecycle.gotoReports();
    await lifecycle.openLifecycle();
    await lifecycle.refreshAndWaitForRun();

    const quarter = lifecycle.timelineQuarter(0).first();
    await expect(quarter).toBeVisible();
    await expect(quarter).toHaveAttribute('title', /^Q[1-4] \d{4}$/);

    // The seeded E2E org keeps self-service off (portal-visibility.spec.ts's
    // negative case for the Devices nav entry), so the link cannot be
    // click-through-navigated in this suite without breaking that assertion.
    // What is exercised end to end is the wiring: a real device row renders a
    // real /devices#<id> anchor, base-path included.
    const planTable = lifecycle.planTable('workstations');
    const link = planTable.getByTestId(/^lifecycle-plan-row-link-/).first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /\/devices#.+/);
  });
});
