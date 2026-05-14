import { BasePage } from './BasePage';

export class ThirdPartyCatalogPage extends BasePage {
  url = '/admin/third-party-catalog';

  search = () => this.page.getByTestId('catalog-search');
  total = () => this.page.getByTestId('catalog-total');
  refresh = () => this.page.getByTestId('catalog-refresh');
  addButton = () => this.page.getByTestId('catalog-add-button');
  testedFilter = () => this.page.getByTestId('catalog-filter-tested');
  editor = () => this.page.getByTestId('catalog-editor-modal');
  empty = () => this.page.getByTestId('catalog-empty');

  async goto() {
    await this.page.goto(this.url);
    await this.search().waitFor();
  }

  rowsLocator() {
    return this.page.locator('[data-testid^="catalog-row-"]').locator('visible=true');
  }
}
