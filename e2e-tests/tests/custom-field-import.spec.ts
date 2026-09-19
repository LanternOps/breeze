import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { RmmCustomFieldImportPage } from '../pages/RmmCustomFieldImportPage';

/**
 * "Import from another RMM" wizard (#3257 W09, #4777).
 *
 * Covers the one flow unit tests cannot: a real upload, through real column
 * mapping and preview, landing on a real device via the API's own resolver —
 * ending with the value visible on the device detail page.
 *
 * Fixtures: the two deterministic devices `seedE2eFixtures.ts` seeds on every
 * fresh DB (`E2E_WINDOWS_DEVICE_ID` / hostname `e2e-windows.local`). Their
 * hostnames are distinct, so this spec proves the `matched` (unambiguous)
 * path end-to-end. It does NOT exercise the ambiguous-row "pick a candidate"
 * sub-flow — that needs a SECOND device sharing a hostname with an existing
 * one, which no current e2e fixture provides and which is outside this
 * wave's file-ownership scope (`seedE2eFixtures.ts` is not a file this wave
 * owns). See the PR's not-verified list. The candidate-picking UI itself is
 * covered at the unit level, exhaustively, in
 * `CustomFieldImportPreviewTable.test.tsx`.
 *
 * Idempotent by design: the definitions step handles BOTH a fresh run
 * (annotation `create`, commits) and a re-run against a DB that already has
 * this field (annotation `already-exists`, skips straight to values) —
 * whichever the API's own preview says, exactly the wizard's own designed
 * behavior for re-imports.
 */

const E2E_WINDOWS_DEVICE_ID = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';
const WINDOWS_HOSTNAME = 'e2e-windows.local';

// A stable field key derived (by the wizard's own generateFieldKey) from this
// exact source label — see CustomFieldDefinitionImportStep.tsx.
const SOURCE_LABEL = 'e2e import note';
const FIELD_KEY = 'e2e_import_note';
const IMPORTED_VALUE = `Imported via E2E ${Date.now()}`;

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('RMM custom-field import wizard', () => {
  test('upload -> map -> preview -> commit definitions, then values, then the value shows on the device', async ({
    authedPage,
  }) => {
    test.setTimeout(120_000);

    const wizard = new RmmCustomFieldImportPage(authedPage);

    await authedPage.goto('/devices');
    await authedPage.getByTestId('devices-page-import-rmm').click();
    await expect(wizard.wizard()).toBeVisible();

    // ---- Step 1: definitions ----
    await wizard.upload(wizard.defFileInput(), `Slot\n${SOURCE_LABEL}\n`, 'fields.csv');
    await expect(wizard.defNameInput(SOURCE_LABEL)).toHaveValue(SOURCE_LABEL);

    await wizard.defPreviewButton().click();

    const skipButton = wizard.defSkipToValuesButton();
    const commitButton = wizard.defCommitButton();
    await expect(skipButton.or(commitButton)).toBeVisible({ timeout: 15_000 });

    if (await skipButton.isVisible()) {
      // Re-run against a DB that already has this field (annotation
      // already-exists) — the wizard's own designed skip path.
      await skipButton.click();
    } else {
      await commitButton.click();
    }

    // ---- Step 2: values ----
    await expect(authedPage).toHaveURL(/#import-values$/);
    await wizard.upload(
      wizard.valFileInput(),
      `Hostname,Note\n${WINDOWS_HOSTNAME},${IMPORTED_VALUE}\n`,
      'values.csv',
    );

    await wizard.valMapSelect('Hostname').selectOption('identifier:hostname');
    await wizard.valMapSelect('Note').selectOption('customField');
    await wizard.valFieldKeyInput('Note').fill(FIELD_KEY);

    await wizard.valPreviewButton().click();

    // The seeded Windows device's hostname is unique across the org, so this
    // resolves unambiguously — no candidate pick required.
    await expect(wizard.importRow(0)).toBeVisible({ timeout: 15_000 });
    await expect(wizard.importRow(0)).toHaveAttribute('aria-disabled', 'false');
    await expect(wizard.importSelect(0)).toBeChecked();

    await wizard.valCommitButton().click();
    await expect(wizard.valSummary()).toBeVisible({ timeout: 15_000 });

    // ---- Verify: the value landed on the device detail page ----
    await authedPage.goto(`/devices/${E2E_WINDOWS_DEVICE_ID}#details`);
    await expect(authedPage.getByTestId(`device-custom-field-value-${FIELD_KEY}`)).toHaveText(
      IMPORTED_VALUE,
      { timeout: 15_000 },
    );
  });
});
