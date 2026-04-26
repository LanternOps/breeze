// e2e-tests/playwright/tests/fleet.spec.ts
//
// Converted from: fleet_management.yaml
import { test, expect } from '../fixtures';
import { FleetPage } from '../pages/FleetPage';

test.describe('Fleet Orchestration', () => {
  test('page loads with heading, subtitle and refresh button', async ({ authedPage }) => {
    const fleet = new FleetPage(authedPage);
    await fleet.goto();
    await expect(fleet.heading()).toBeVisible();
    await expect(fleet.subtitle()).toBeVisible();
    await expect(fleet.refreshButton()).toBeVisible();
  });

  test('all eight stat cards are rendered', async ({ authedPage }) => {
    const fleet = new FleetPage(authedPage);
    await fleet.goto();
    await expect(fleet.policiesCard()).toBeVisible();
    await expect(fleet.deploymentsCard()).toBeVisible();
    await expect(fleet.patchesCard()).toBeVisible();
    await expect(fleet.alertsCard()).toBeVisible();
    await expect(fleet.groupsCard()).toBeVisible();
    await expect(fleet.automationsCard()).toBeVisible();
    await expect(fleet.maintenanceCard()).toBeVisible();
    await expect(fleet.reportsCard()).toBeVisible();
  });

  test('AI fleet actions panel renders all eight quick action buttons', async ({ authedPage }) => {
    const fleet = new FleetPage(authedPage);
    await fleet.goto();
    await expect(fleet.aiFleetActionsHeading()).toBeVisible();
    await expect(fleet.checkComplianceButton()).toBeVisible();
    await expect(fleet.activeDeploymentsButton()).toBeVisible();
    await expect(fleet.criticalPatchesButton()).toBeVisible();
    await expect(fleet.alertOverviewButton()).toBeVisible();
    await expect(fleet.maintenanceWindowsButton()).toBeVisible();
    await expect(fleet.runAutomationsButton()).toBeVisible();
    await expect(fleet.deviceGroupsButton()).toBeVisible();
    await expect(fleet.generateReportButton()).toBeVisible();
  });

  test('status overview panels render (deployment, alert, patch, policy)', async ({ authedPage }) => {
    const fleet = new FleetPage(authedPage);
    await fleet.goto();
    await expect(fleet.deploymentStatusPanel()).toBeVisible();
    await expect(fleet.alertBreakdownPanel()).toBeVisible();
    await expect(fleet.patchPosturePanel()).toBeVisible();
    await expect(fleet.policyCompliancePanel()).toBeVisible();
  });

  test('deployment status panel shows bar labels', async ({ authedPage }) => {
    const fleet = new FleetPage(authedPage);
    await fleet.goto();
    await expect(fleet.activeLabel()).toBeVisible();
    await expect(fleet.pendingLabel()).toBeVisible();
    await expect(fleet.completedLabel()).toBeVisible();
    await expect(fleet.failedLabel()).toBeVisible();
  });

  test('refresh button reloads stats without error', async ({ authedPage }) => {
    const fleet = new FleetPage(authedPage);
    await fleet.goto();
    await fleet.refreshButton().click();
    // After refresh the stat cards should still be visible
    await expect(fleet.policiesCard()).toBeVisible();
  });
});
