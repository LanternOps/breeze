// e2e-tests/playwright/pages/SettingsPage.ts
import { BasePage } from './BasePage';

export class SettingsPage extends BasePage {
  // Settings overview (/settings)
  heading = () => this.page.getByRole('heading', { level: 1 });
  settingsHeading = () => this.page.getByRole('heading', { name: 'Settings' });
  organizationsCard = () => this.page.getByText('Organizations');
  usersCard = () => this.page.getByText('Users');
  sitesCard = () => this.page.getByText('Sites');
  settingsDescription = () => this.page.getByText('Manage your organization settings');

  async goto() {
    await this.page.goto('/settings');
    await this.settingsHeading().waitFor();
  }

  // Users (/settings/users)
  usersHeading = () => this.page.getByRole('heading', { name: 'Users' });
  inviteUserButton = () => this.page.getByRole('button', { name: 'Invite user' });
  userSearchInput = () => this.page.locator('#user-search');

  async gotoUsers() {
    await this.page.goto('/settings/users');
    await this.usersHeading().waitFor();
  }

  // Roles (/settings/roles)
  rolesHeading = () => this.page.getByRole('heading', { name: 'Roles' });
  rolesDescription = () => this.page.getByText('Manage user roles and permissions');
  createRoleButton = () => this.page.getByRole('button', { name: 'Create' });

  async gotoRoles() {
    await this.page.goto('/settings/roles');
    await this.rolesHeading().waitFor();
  }

  // API Keys (/settings/api-keys)
  apiKeysHeading = () => this.page.getByRole('heading', { name: 'API Keys' });
  createKeyButton = () => this.page.getByRole('button', { name: 'Create Key' });
  apiKeySearchInput = () => this.page.getByRole('textbox', { name: /search by name/i });

  async gotoApiKeys() {
    await this.page.goto('/settings/api-keys');
    await this.apiKeysHeading().waitFor();
  }

  // Enrollment Keys (/settings/enrollment-keys)
  enrollmentKeysHeading = () => this.page.getByRole('heading', { name: 'Enrollment Keys' });
  createEnrollmentKeyButton = () => this.page.getByRole('button', { name: 'Create Key' });

  async gotoEnrollmentKeys() {
    await this.page.goto('/settings/enrollment-keys');
    await this.enrollmentKeysHeading().waitFor();
  }

  // SSO (/settings/sso)
  ssoHeading = () => this.page.getByRole('heading', { name: 'Single Sign-On' });
  ssoDescription = () => this.page.getByText('Configure SSO providers');
  addProviderButton = () => this.page.getByRole('button', { name: 'Add provider' });

  async gotoSso() {
    await this.page.goto('/settings/sso');
    await this.ssoHeading().waitFor();
  }

  // Profile (/settings/profile)
  profileHeading = () => this.page.getByRole('heading', { name: 'Profile settings' });
  nameLabel = () => this.page.getByLabel('Name');
  avatarUrlLabel = () => this.page.getByLabel('Avatar image URL');
  emailInput = () => this.page.locator('#email');
  nameInput = () => this.page.locator('#name');
  avatarUrlInput = () => this.page.locator('#avatarUrl');
  saveChangesButton = () => this.page.getByRole('button', { name: 'Save changes' });
  profileInfoSection = () => this.page.getByText('Profile information');

  async gotoProfile() {
    await this.page.goto('/settings/profile');
    await this.profileHeading().waitFor();
  }

  // AI Usage (/settings/ai-usage)
  aiUsageHeading = () => this.page.getByRole('heading', { name: 'AI Usage' });
  todaysCostCard = () => this.page.getByText("Today's Cost");
  monthlyCostCard = () => this.page.getByText('Monthly Cost');
  messagesTodayCard = () => this.page.getByText('Messages Today');
  tokensThisMonthCard = () => this.page.getByText('Tokens This Month');
  budgetConfigSection = () => this.page.getByText('Budget Configuration');
  saveBudgetButton = () => this.page.getByRole('button', { name: 'Save Budget' });
  recentSessionsTable = () => this.page.getByText('Recent Sessions');

  async gotoAiUsage() {
    await this.page.goto('/settings/ai-usage');
    await this.aiUsageHeading().waitFor();
  }

  // Access Reviews (/settings/access-reviews)
  accessReviewsHeading = () => this.page.getByText('Access Reviews');
  newReviewButton = () => this.page.getByRole('button', { name: 'New Review' });

  async gotoAccessReviews() {
    await this.page.goto('/settings/access-reviews');
    await this.accessReviewsHeading().waitFor();
  }

  // Sites (/settings/sites)
  sitesHeading = () => this.page.getByText('Sites');

  async gotoSites() {
    await this.page.goto('/settings/sites');
    await this.sitesHeading().waitFor();
  }

  // Custom Fields (/settings/custom-fields)
  customFieldsHeading = () => this.page.getByText('Custom Fields');

  async gotoCustomFields() {
    await this.page.goto('/settings/custom-fields');
    await this.customFieldsHeading().waitFor();
  }
}
