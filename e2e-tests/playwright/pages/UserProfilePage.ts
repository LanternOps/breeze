// e2e-tests/playwright/pages/UserProfilePage.ts
import { BasePage } from './BasePage';

export class UserProfilePage extends BasePage {
  url = '/settings/profile';

  // Page structure
  heading = () => this.page.getByRole('heading', { name: 'Profile settings' });
  pageDescription = () => this.page.getByText('Manage your account settings');
  profileInfoSection = () => this.page.getByRole('heading', { name: 'Profile information' });

  // Profile info form
  nameLabel = () => this.page.getByLabel('Name');
  avatarUrlLabel = () => this.page.getByLabel('Avatar image URL');
  emailLabel = () => this.page.getByLabel('Email');
  nameInput = () => this.page.locator('input#name');
  avatarUrlInput = () => this.page.locator('input#avatarUrl');
  emailInput = () => this.page.locator('input#email');
  saveChangesButton = () => this.page.getByRole('button', { name: 'Save changes' });

  // Change password section
  changePasswordSection = () => this.page.getByRole('heading', { name: 'Change password' });
  currentPasswordInput = () => this.page.locator('input#currentPassword');
  newPasswordInput = () => this.page.locator('input#newPassword');
  confirmPasswordInput = () => this.page.locator('input#confirmPassword');
  changePasswordButton = () => this.page.getByRole('button', { name: 'Change password' });

  // Email cannot be changed note
  emailCannotBeChangedNote = () => this.page.getByText('Email cannot be changed');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async gotoProfile() {
    await this.page.goto(this.url);
    await this.nameInput().waitFor();
  }
}
