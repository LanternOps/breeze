import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { X } from 'lucide-react';
import { useHashTab } from '../../lib/useHashState';
import CustomFieldDefinitionImportStep, { type ImportSystem } from './CustomFieldDefinitionImportStep';
import CustomFieldValueImportStep from './CustomFieldValueImportStep';

/**
 * The "Import from another RMM" wizard shell (#3257 W09).
 *
 * Step state lives in `window.location.hash` (`#import-definitions` /
 * `#import-values`), never a query param, per repo convention
 * (`DeviceDetails.tsx`, `OrganizationsPage.tsx`). The source picker (plan's
 * "Step 0") lives here rather than in the definitions step, since the values
 * step needs no source at all — it maps CSV columns directly.
 */

const STEPS = ['import-definitions', 'import-values'] as const;
type WizardStep = (typeof STEPS)[number];

const IMPORT_SYSTEMS: ImportSystem[] = ['datto_rmm', 'ninjaone', 'cw_automate', 'n_central', 'csv'];

interface Props {
  organizationId: string | null;
  onClose: () => void;
}

export default function RmmCustomFieldImport({ organizationId, onClose }: Props) {
  const { t } = useTranslation('devices');
  const [step, setStep] = useHashTab<WizardStep>(STEPS, 'import-definitions');
  const [source, setSource] = useState<ImportSystem>('datto_rmm');

  function goToStep(next: WizardStep) {
    window.location.hash = next;
    setStep(next);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
      <div
        data-testid="rmm-import-wizard"
        className="w-full max-w-3xl my-8 rounded-lg border bg-card p-6 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('rmmCustomFieldImport.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('rmmCustomFieldImport.description')}</p>
          </div>
          <button
            type="button"
            data-testid="rmm-import-close"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('rmmCustomFieldImport.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="mt-4 flex items-center gap-4 text-xs font-medium text-muted-foreground">
          <li
            data-testid="rmm-import-step-definitions-tab"
            className={step === 'import-definitions' ? 'text-foreground' : ''}
          >
            1. {t('rmmCustomFieldImport.steps.definitions')}
          </li>
          <li data-testid="rmm-import-step-values-tab" className={step === 'import-values' ? 'text-foreground' : ''}>
            2. {t('rmmCustomFieldImport.steps.values')}
          </li>
        </ol>

        {step === 'import-definitions' && (
          <div className="mt-4 space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('rmmCustomFieldImport.sourceLabel')}</span>
              <select
                data-testid="rmm-import-source"
                value={source}
                onChange={(e) => setSource(e.target.value as ImportSystem)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {IMPORT_SYSTEMS.map((s) => (
                  <option key={s} value={s}>
                    {t(/* i18n-dynamic */ `rmmCustomFieldImport.sources.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <CustomFieldDefinitionImportStep
              source={source}
              organizationId={organizationId}
              onSkipToValues={() => goToStep('import-values')}
              onCommitted={(summary) => {
                // A definitions commit always leaves this step meaningfully
                // done — created rows exist now, and any row that didn't
                // commit needed a fix the operator has already seen. Either
                // way there's nothing further to do on this step.
                if (summary.created.length > 0 || summary.errors.length === 0) {
                  goToStep('import-values');
                }
              }}
            />
          </div>
        )}

        {step === 'import-values' && (
          <div className="mt-4 space-y-4">
            <button
              type="button"
              data-testid="rmm-import-back-to-definitions"
              onClick={() => goToStep('import-definitions')}
              className="text-xs font-medium text-primary hover:underline"
            >
              {t('rmmCustomFieldImport.backToDefinitions')}
            </button>
            <CustomFieldValueImportStep organizationId={organizationId} source={source} />
          </div>
        )}
      </div>
    </div>
  );
}
