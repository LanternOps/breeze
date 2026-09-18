import type { Page } from '@playwright/test';
import { waitForHydration } from './hydration';

export class PortalHardwareLifecyclePage {
  constructor(private page: Page) {}

  reportsNav = () => this.page.getByTestId('portal-nav-reports');
  lifecycleCard = () => this.page.getByTestId('reports-lifecycle-card');
  refresh = () => this.page.getByTestId('lifecycle-refresh');
  statusBar = () => this.page.getByTestId('lifecycle-status-bar');
  statusSegment = (band: string) =>
    this.page.getByTestId(`lifecycle-status-segment-${band}`);
  schedule = () => this.page.getByTestId('lifecycle-schedule');
  planTable = (sectionId: string) =>
    this.page.getByTestId(`lifecycle-plan-table-${sectionId}`);
  planRowLink = (deviceId: string) =>
    this.page.getByTestId(`lifecycle-plan-row-link-${deviceId}`);
  timelineQuarter = (index: number) =>
    this.page.getByTestId(`lifecycle-timeline-quarter-${index}`);

  /** Navigate to /reports and wait for the ReportRunList island to hydrate
   *  (the lifecycle card itself is plain server-rendered HTML, not an island). */
  async gotoReports(): Promise<void> {
    await this.page.goto('/portal/reports');
    await waitForHydration(this.page, 'portal-reports-generate-posture');
  }

  async openLifecycle(): Promise<void> {
    await this.lifecycleCard().click();
    await this.page.waitForURL(/\/portal\/reports\/lifecycle(?:[?#]|$)/);
    await waitForHydration(this.page, 'lifecycle-refresh');
  }

  /** Refresh and wait for the status bar to render — first-run generation is
   *  synchronous on the API side but slow, so this uses a generous timeout
   *  matching portal-visibility.spec.ts's posture-report convention. */
  async refreshAndWaitForRun(): Promise<void> {
    await this.refresh().click();
    await this.statusBar().waitFor({ timeout: 30_000 });
  }
}
