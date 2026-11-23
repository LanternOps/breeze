import type { Page } from '@playwright/test';

// Configuration policy create, detail and list pages (#12306). Test IDs only.
export class ConfigPolicyPage {
  listUrl = '/configuration-policies';
  newUrl = '/configuration-policies/new';

  constructor(private page: Page) {}

  detailUrl = (id: string) => `/configuration-policies/${id}`;

  // Create page
  createModeNew = () => this.page.getByTestId('config-policy-create-mode-new');
  createName = () => this.page.getByTestId('config-policy-create-name');
  ownerPartner = () => this.page.getByTestId('policy-owner-partner');
  createSubmit = () => this.page.getByTestId('config-policy-create-submit');

  // Applies-to strip on the policy page
  strip = () => this.page.getByTestId('config-policy-applies-to-strip');
  stripTargets = () => this.page.getByTestId('config-policy-applies-to-target');
  stripNotApplied = () => this.page.getByTestId('config-policy-applies-to-not-applied');
  stripAssign = () => this.page.getByTestId('config-policy-applies-to-assign');
  stripEdit = () => this.page.getByTestId('config-policy-applies-to-edit');

  // Applies-to drawer
  drawer = () => this.page.getByTestId('config-policy-applies-to-drawer');
  drawerClose = () => this.page.getByTestId('config-policy-applies-to-drawer-close');
  stripReach = () => this.page.getByTestId('config-policy-applies-to-reach');

  // Applies-to panel in the drawer (#12467)
  panel = () => this.page.getByTestId('applies-to-panel');
  allOrgs = () => this.page.getByTestId('applies-to-all-orgs');
  specificTargets = () => this.page.getByTestId('applies-to-specific');
  panelRows = (state: 'added' | 'changed' | 'removed' | 'unchanged') =>
    this.page.locator(`[data-testid^="applies-to-row-"][data-state="${state}"]`);
  applyButton = () => this.page.getByTestId('applies-to-apply');
  legend = () => this.page.getByTestId('applies-to-legend');
  pickerLevel = (level: 'organization' | 'site' | 'device_group' | 'device') => this.page.getByTestId(`target-picker-level-${level}`);
  pickerSearch = () => this.page.getByTestId('target-picker-search');
  pickerOptions = () => this.page.locator('[data-testid^="target-picker-option-"]');
  pickerOrgOptions = () => this.page.locator('[data-testid^="target-picker-org-"]');
  pickerChangeOrg = () => this.page.getByTestId('target-picker-change-org');

  // List page
  row = (id: string) => this.page.locator(`[data-testid="config-policy-row"][data-policy-id="${id}"]`);
  appliesToCell = (id: string) => this.row(id).getByTestId('config-policy-applies-to-cell');
  notAppliedBadge = (id: string) => this.row(id).getByTestId('config-policy-not-applied-badge');
  deleteButton = (id: string) => this.row(id).getByTestId('config-policy-delete-button');
  deleteConfirm = () => this.page.getByTestId('config-policy-delete-confirm');
}
