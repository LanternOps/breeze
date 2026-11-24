import type { Page } from '@playwright/test';

// Configuration policy create, detail and list pages (#12306). Test IDs only.
export class ConfigPolicyPage {
  listUrl = '/configuration-policies';
  newUrl = '/configuration-policies/new';

  constructor(private page: Page) {}

  detailUrl = (id: string) => `/configuration-policies/${id}`;

  // Create mode on the policy page (#12471)
  createHeader = () => this.page.getByTestId('config-policy-create-header');
  createName = () => this.page.getByTestId('config-policy-create-name');
  managedBySelect = () => this.page.getByTestId('config-policy-managed-by-select');
  managedByMspOption = () => this.page.getByTestId('config-policy-managed-by-msp');
  managedByFixed = () => this.page.getByTestId('config-policy-managed-by-fixed');
  ownerTrade = () => this.page.getByTestId('config-policy-owner-trade');
  fixedAtFirstSave = () => this.page.getByTestId('config-policy-fixed-at-first-save');
  ownerFixed = () => this.page.getByTestId('config-policy-owner-fixed');

  // Feature rail and the open feature
  railItem = (featureType: string) => this.page.getByTestId(`config-policy-rail-tab-${featureType}`);
  featurePanel = () => this.page.getByTestId('config-policy-feature-panel');
  featureSave = () => this.page.getByTestId('feature-tab-footer').getByRole('button', { name: /^Save/ });

  // Header state and actions
  statusPill = () => this.page.getByTestId('config-policy-status-pill');
  activate = () => this.page.getByTestId('config-policy-activate');
  activationActivate = () => this.page.getByTestId('config-policy-activation-activate');
  activationDontApply = () => this.page.getByTestId('config-policy-activation-dont-apply');

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
  rows = () => this.page.getByTestId('config-policy-row');
  orgFilter = () => this.page.getByTestId('config-policy-org-filter');
  notAppliedFilter = () => this.page.getByTestId('config-policy-not-applied-filter');
  row = (id: string) => this.page.locator(`[data-testid="config-policy-row"][data-policy-id="${id}"]`);
  appliesToCell = (id: string) => this.row(id).getByTestId('config-policy-applies-to-cell');
  notAppliedBadge = (id: string) => this.row(id).getByTestId('config-policy-not-applied-badge');
  deleteButton = (id: string) => this.row(id).getByTestId('config-policy-delete-button');
  deleteConfirm = () => this.page.getByTestId('config-policy-delete-confirm');
}
