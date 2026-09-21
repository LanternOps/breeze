// apps/web/src/components/devices/networkDevice/settings/SettingsSectionShell.tsx
// Per-section frame: heading, optional description, body, and the Save/Cancel
// row that only appears once the section is dirty. Every section in the modal
// saves independently (spec §10), so the footer belongs to the section rather
// than to the dialog.

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingsSection } from './settingsHash';

export function SettingsSectionShell({
  section,
  title,
  description,
  dirty = false,
  saving = false,
  saveDisabled = false,
  onSave,
  onCancel,
  children,
}: {
  section: SettingsSection;
  title: string;
  description?: string;
  dirty?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('devices');
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid={`network-settings-panel-${section}`}
      aria-labelledby={`network-settings-heading-${section}`}
    >
      <div className="border-b px-5 py-4">
        <h3 id={`network-settings-heading-${section}`} className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {onSave && (
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {dirty && (
            <span className="mr-auto text-xs text-muted-foreground" data-testid={`network-settings-${section}-dirty`}>
              {t('networkDeviceDetailPage.settings.unsavedChanges')}
            </span>
          )}
          <button
            type="button"
            data-testid={`network-settings-${section}-cancel`}
            onClick={onCancel}
            disabled={!dirty || saving}
            className="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid={`network-settings-${section}-save`}
            onClick={onSave}
            disabled={!dirty || saving || saveDisabled}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      )}
    </section>
  );
}
