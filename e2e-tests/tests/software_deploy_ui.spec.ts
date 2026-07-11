import { test, expect } from '../fixtures';

// Live verification of the single-step Add Package modal + installer URL
// variables (PR: ToddHebebrand/software-deploy-UI). Kept as ONE test in a single
// session — the shared storageState auth rotates, so a second test in the same
// file would land on /login (known Breeze e2e gotcha). Queries by role/text
// since the new components predate data-testids.
test('Software Library: single-step Add Package modal + installer variable validation', async ({
  authedPage,
}) => {
  await authedPage.goto('/software');
  await expect(authedPage.getByRole('heading', { name: 'Software Library' })).toBeVisible();

  await authedPage.getByRole('button', { name: 'Add Package' }).click();

  const dialog = authedPage.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add software package' })).toBeVisible();

  // Identity + first version live in ONE modal (no create-then-versions-tab).
  await expect(dialog.getByLabel('Name')).toBeVisible();
  await expect(dialog.getByLabel('Version')).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Download URL' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Upload file' })).toBeVisible();
  // Required first version: Create is gated until name + version + source.
  await expect(dialog.getByRole('button', { name: 'Create package' })).toBeDisabled();

  const url = dialog.getByPlaceholder('https://example.com/package-v1.0.0.msi');

  // Unknown variable → warning + Create stays disabled (never ships a bad URL).
  await dialog.getByLabel('Name').fill('Playwright Test App');
  await dialog.getByLabel('Version').fill('1.2.3');
  await url.fill('https://dl/{{org.bogus}}/app.msi');
  await expect(dialog.getByText(/Unknown variable/i)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create package' })).toBeDisabled();

  // Valid built-in variable → warning clears, Create enables.
  await url.fill('https://dl/{{org.name}}/app.msi');
  await expect(dialog.getByText(/Unknown variable/i)).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Create package' })).toBeEnabled();

  // The Insert-variable affordance is present on the URL field.
  await expect(dialog.getByRole('button', { name: /Insert variable/i }).first()).toBeVisible();
});
