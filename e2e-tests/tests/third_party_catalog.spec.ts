import { test, expect } from '../fixtures';
import { ThirdPartyCatalogPage } from '../pages/ThirdPartyCatalogPage';

test.describe('Third-Party Package Catalog', () => {
  test('loads with seeded entries visible', async ({ authedPage }) => {
    const catalog = new ThirdPartyCatalogPage(authedPage);
    await catalog.goto();

    await expect(catalog.total()).not.toHaveText('0');

    await expect(authedPage.getByText('Mozilla.Firefox')).toBeVisible();
    await expect(authedPage.getByText('Google.Chrome')).toBeVisible();
  });

  test('search filters the table by name or vendor', async ({ authedPage }) => {
    const catalog = new ThirdPartyCatalogPage(authedPage);
    await catalog.goto();

    await catalog.search().fill('firefox');

    await expect(authedPage.getByText('Mozilla.Firefox')).toBeVisible();
    await expect(authedPage.getByText('Google.Chrome')).toBeHidden();
  });

  test('opens the editor when "Add package" is clicked', async ({ authedPage }) => {
    const catalog = new ThirdPartyCatalogPage(authedPage);
    await catalog.goto();

    await catalog.addButton().click();
    await expect(catalog.editor()).toBeVisible();
    await expect(authedPage.getByText('Add catalog entry')).toBeVisible();
  });
});
