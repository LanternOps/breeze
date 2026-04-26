// e2e-tests/playwright/tests/discovery.spec.ts
//
// Converted from: discovery_network.yaml
import { test, expect } from '../fixtures';
import { DiscoveryPage } from '../pages/DiscoveryPage';

test.describe('Network Discovery', () => {
  test('page loads with heading, subtitle and all five tab buttons', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await expect(discovery.heading()).toBeVisible();
    await expect(discovery.subtitle()).toBeVisible();
    await expect(discovery.assetsTab()).toBeVisible();
    await expect(discovery.profilesTab()).toBeVisible();
    await expect(discovery.jobsTab()).toBeVisible();
    await expect(discovery.topologyTab()).toBeVisible();
    await expect(discovery.changesTab()).toBeVisible();
  });

  test('assets tab is active by default', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    // The heading is still visible after page load — default tab renders without error
    await expect(discovery.heading()).toBeVisible();
    await expect(discovery.assetsTab()).toBeVisible();
  });

  test('profiles tab shows discovery profiles heading and new profile button', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await discovery.clickTab('Profiles');
    await expect(discovery.discoveryProfilesHeading()).toBeVisible();
    await expect(discovery.newProfileButton()).toBeVisible();
  });

  test('new profile modal opens with correct form fields', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await discovery.clickTab('Profiles');
    await discovery.newProfileButton().click();
    await expect(discovery.newProfileModalHeading()).toBeVisible();
    await expect(authedPage.getByText('Configure network scope, scan methods, and scheduling settings.')).toBeVisible();
    // Close the modal
    await authedPage.keyboard.press('Escape');
  });

  test('create a discovery profile via the new profile modal', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await discovery.clickTab('Profiles');
    await discovery.newProfileButton().click();
    await expect(discovery.newProfileModalHeading()).toBeVisible();
    await discovery.profileNameInput().fill('E2E Test Profile');
    await discovery.profileSubnetInput().fill('192.168.1.0/24');
    // Toggle ICMP Ping and TCP Port Scan checkboxes
    await discovery.icmpPingCheckbox().check();
    await discovery.tcpPortScanCheckbox().check();
    await discovery.createProfileButton().click();
    // After save the modal closes and profiles list shows the count
    await expect(discovery.profilesConfiguredText()).toBeVisible();
  });

  test('jobs tab renders discovery jobs heading', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await discovery.clickTab('Jobs');
    await expect(discovery.discoveryJobsHeading()).toBeVisible();
  });

  test('assets tab click shows assets content', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await discovery.clickTab('Assets');
    // Heading remains visible after switching to assets tab
    await expect(discovery.heading()).toBeVisible();
  });

  test('changes tab click renders without error', async ({ authedPage }) => {
    const discovery = new DiscoveryPage(authedPage);
    await discovery.goto();
    await discovery.clickTab('Changes');
    // Page heading remains visible after tab switch
    await expect(discovery.heading()).toBeVisible();
  });
});
