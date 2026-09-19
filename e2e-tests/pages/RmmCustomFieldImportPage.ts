import { BasePage } from './BasePage';

/**
 * The "Import from another RMM" wizard (#3257 W09). Reachable from the
 * devices list (`devices-page-import-rmm`) and Settings → Custom Fields
 * (`custom-field-import-rmm`) — both open the same `RmmCustomFieldImport`
 * component, so one Page Object covers it from either entry point.
 */
export class RmmCustomFieldImportPage extends BasePage {
  wizard = () => this.page.getByTestId('rmm-import-wizard');
  closeButton = () => this.page.getByTestId('rmm-import-close');
  sourceSelect = () => this.page.getByTestId('rmm-import-source');
  backToDefinitionsButton = () => this.page.getByTestId('rmm-import-back-to-definitions');

  // ---- Step 1: definitions ----
  defFileInput = () => this.page.getByTestId('cf-def-file-input');
  defPreviewButton = () => this.page.getByTestId('cf-def-preview');
  defCommitButton = () => this.page.getByTestId('cf-def-commit');
  defSkipToValuesButton = () => this.page.getByTestId('cf-def-skip-to-values');
  defNameInput = (sourceLabel: string) => this.page.getByTestId(`cf-def-name-${sourceLabel}`);
  defTypeSelect = (sourceLabel: string) => this.page.getByTestId(`cf-def-type-${sourceLabel}`);
  defRow = (index: number) => this.page.getByTestId(`cf-def-row-${index}`);
  defAnnotation = (annotation: string) => this.page.getByTestId(`cf-def-annotation-${annotation}`);

  // ---- Step 2: values ----
  valFileInput = () => this.page.getByTestId('cf-val-file-input');
  valMapSelect = (header: string) => this.page.getByTestId(`cf-val-map-${header}`);
  valFieldKeyInput = (header: string) => this.page.getByTestId(`cf-val-fieldkey-${header}`);
  valPreviewButton = () => this.page.getByTestId('cf-val-preview');
  valCommitButton = () => this.page.getByTestId('cf-val-commit');
  valSummary = () => this.page.getByTestId('cf-val-summary');

  // ---- Shared preview table (values step) ----
  importRow = (index: number) => this.page.getByTestId(`cf-import-row-${index}`);
  importSelect = (index: number) => this.page.getByTestId(`cf-import-select-${index}`);
  importExpand = (index: number) => this.page.getByTestId(`cf-import-expand-${index}`);
  importCandidate = (candidateIndex: number) => this.page.getByTestId(`cf-import-candidate-${candidateIndex}`);
  importCandidatePick = (candidateIndex: number) =>
    this.page.getByTestId(`cf-import-candidate-${candidateIndex}-pick`);
  importSelectAll = () => this.page.getByTestId('cf-import-select-all');

  /** Uploads `csv` (as an in-memory file) to the given file input locator. */
  async upload(fileInput: ReturnType<typeof this.defFileInput>, csv: string, name: string) {
    await fileInput.setInputFiles({
      name,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    });
  }
}
