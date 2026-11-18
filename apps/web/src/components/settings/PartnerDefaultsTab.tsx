import type { InheritableDefaultSettings } from '@breeze/shared';
import {
  ENROLLMENT_TTL_I18N_KEYS,
  ENROLLMENT_TTL_OPTIONS,
  MAX_ENROLLMENT_DEVICE_COUNT,
  MAX_ENROLLMENT_TTL_MINUTES,
  enrollmentTtlOptionsIncluding,
  isValidMaintenanceWindow,
} from '@breeze/shared';
import AgentVersionPinSelectors, { type PinnableVersions } from './AgentVersionPinSelectors';
import FieldLabel from './partnerSettings/FieldLabel';
import SettingBadge from './partnerSettings/SettingBadge';
import InheritanceLine from './partnerSettings/InheritanceLine';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  data: InheritableDefaultSettings;
  onChange: (data: InheritableDefaultSettings) => void;
  pinnableVersions?: PinnableVersions | null;
};

export default function PartnerDefaultsTab({ data, onChange, pinnableVersions }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableDefaultSettings>) =>
    onChange({ ...data, ...patch });

  const autoEnrollment = data.autoEnrollment ?? { enabled: false, requireApproval: true };

  const maintenanceWindow = data.maintenanceWindow ?? '';
  const maintenanceWindowInvalid = maintenanceWindow.trim() !== '' && !isValidMaintenanceWindow(maintenanceWindow);

  // One option set for the Add Device modal and both settings tabs (#2776).
  // The labels are the existing `devices` namespace strings — this component
  // reads the `settings` namespace, so they carry an explicit ns prefix rather
  // than being duplicated into a parallel `settings` key set.
  const renderTtlOptions = (minutesList: readonly number[]) =>
    minutesList.map(minutes => (
      <option key={minutes} value={minutes}>
        {ENROLLMENT_TTL_I18N_KEYS[minutes]
          ? t(/* i18n-dynamic */ `devices:${ENROLLMENT_TTL_I18N_KEYS[minutes]}`)
          // Non-canonical minute value (an API-set cap). Reuses the org
          // editor's existing bare-minutes string rather than minting a
          // parallel partner key in all seven locales.
          : t('orgDefaultsEditor.enrollment.capMinutes', { minutes })}
      </option>
    ));

  // The cap picker itself must offer the full range — it is the thing being
  // defined. The DEFAULT picker must not: resolveEnrollmentDefaults clamps the
  // resolved default to the cap, so offering "1 year" under a 1-hour cap would
  // advertise a lifetime no link ever gets (the same silent discard #2776 is
  // about, just self-inflicted rather than inherited).
  //
  // An already-stored over-cap default is still shown as its own option rather
  // than clamped for display. This component is controlled — it never rewrites
  // `data`, it only renders it — so displaying a clamped value while the parent
  // saved the raw one would mean showing "1 hour" and persisting 525600.
  const partnerCap = data.maxEnrollmentLinkTtlMinutes ?? MAX_ENROLLMENT_TTL_MINUTES;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <FieldLabel htmlFor="partner-defaults-update-policy" fieldId="defaults.agentUpdatePolicy">{t('partnerDefaults.updatePolicy')}</FieldLabel>
          <select
            id="partner-defaults-update-policy"
            // Fold the legacy 'staged' value into 'auto' for display — they are
            // behaviourally identical (both maintenance-window gated; no real
            // staged rollout exists, see #1962). The backend still accepts
            // 'staged' for back-compat.
            value={data.agentUpdatePolicy === 'staged' ? 'auto' : (data.agentUpdatePolicy ?? '')}
            onChange={e => set({ agentUpdatePolicy: e.target.value || undefined })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('partnerDefaults.notSet')}</option>
            <option value="auto">{t('partnerDefaults.automatic')}</option>
            <option value="manual">{t('partnerDefaults.manual')}</option>
          </select>
          <InheritanceLine fieldId="defaults.agentUpdatePolicy" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-defaults-maintenance-window" fieldId="defaults.maintenanceWindow">{t('partnerDefaults.maintenanceWindow')}</FieldLabel>
          <input
            id="partner-defaults-maintenance-window"
            aria-describedby="partner-defaults-maintenance-window-hint"
            type="text"
            value={maintenanceWindow}
            onChange={e => set({ maintenanceWindow: e.target.value || undefined })}
            placeholder={t('partnerDefaults.maintenancePlaceholder')}
            aria-invalid={maintenanceWindowInvalid}
            className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
              maintenanceWindowInvalid ? 'border-destructive' : ''
            }`}
          />
          <InheritanceLine fieldId="defaults.maintenanceWindow" />
          {maintenanceWindowInvalid ? (
            <p id="partner-defaults-maintenance-window-hint" className="text-xs text-destructive">
              <Trans i18nKey="partnerDefaults.maintenanceInvalid" t={t} components={{ first: <code />, second: <code />, always: <code /> }} />
            </p>
          ) : (
            <p id="partner-defaults-maintenance-window-hint" className="text-xs text-muted-foreground">
              <Trans i18nKey="partnerDefaults.maintenanceHelp" t={t} components={{ always: <code /> }} />
            </p>
          )}
        </div>

        <div className="space-y-2 sm:col-span-2">
          <AgentVersionPinSelectors
            context="partner"
            value={data.agentVersionPins ?? {}}
            onChange={(agentVersionPins) => set({ agentVersionPins })}
            pinnable={pinnableVersions ?? null}
            labelAddon={key => <SettingBadge fieldId={`defaults.agentVersionPins.${key}`} />}
            footer={key => <InheritanceLine fieldId={`defaults.agentVersionPins.${key}`} />}
          />
        </div>

      </div>

      {/* Auto-enrollment */}
      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold">{t('partnerDefaults.autoEnrollment.title')}</h3>
        <div className="space-y-3">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, enabled: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <span className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.enable')}</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, requireApproval: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <span className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.requireApproval')}</span>
          </label>
        </div>
      </div>

      {/* Enrollment link defaults + the partner-only lifetime cap (#2776) */}
      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold">{t('partnerDefaults.enrollment.title')}</h3>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel htmlFor="partner-enrollment-ttl" fieldId="defaults.defaultEnrollmentTtlMinutes">
              {t('partnerDefaults.enrollment.ttl')}
            </FieldLabel>
            <select
              id="partner-enrollment-ttl"
              data-testid="partner-enrollment-ttl"
              value={data.defaultEnrollmentTtlMinutes ?? ''}
              onChange={e => set({
                defaultEnrollmentTtlMinutes: e.target.value ? Number(e.target.value) : undefined,
              })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('partnerDefaults.notSetTtl')}</option>
              {renderTtlOptions(
                enrollmentTtlOptionsIncluding(partnerCap, data.defaultEnrollmentTtlMinutes),
              )}
            </select>
            <InheritanceLine fieldId="defaults.defaultEnrollmentTtlMinutes" />
            <p className="text-xs text-muted-foreground">
              {t('partnerDefaults.enrollment.ttlHint')}
            </p>
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="partner-enrollment-device-count" fieldId="defaults.defaultEnrollmentDeviceCount">
              {t('partnerDefaults.enrollment.deviceCount')}
            </FieldLabel>
            <input
              id="partner-enrollment-device-count"
              data-testid="partner-enrollment-device-count"
              type="number"
              min={1}
              max={MAX_ENROLLMENT_DEVICE_COUNT}
              value={data.defaultEnrollmentDeviceCount ?? ''}
              onChange={e => set({
                defaultEnrollmentDeviceCount: e.target.value ? Number(e.target.value) : undefined,
              })}
              placeholder={t('partnerDefaults.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
            <InheritanceLine fieldId="defaults.defaultEnrollmentDeviceCount" />
            <p className="text-xs text-muted-foreground">
              {t('partnerDefaults.enrollment.deviceCountHint')}
            </p>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <FieldLabel htmlFor="partner-max-enrollment-ttl" fieldId="defaults.maxEnrollmentLinkTtlMinutes">
              {t('partnerDefaults.enrollment.maxTtl')}
            </FieldLabel>
            <select
              id="partner-max-enrollment-ttl"
              data-testid="partner-max-enrollment-ttl"
              value={data.maxEnrollmentLinkTtlMinutes ?? ''}
              onChange={e => set({
                maxEnrollmentLinkTtlMinutes: e.target.value ? Number(e.target.value) : undefined,
              })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:max-w-xs"
            >
              <option value="">{t('partnerDefaults.notSetMaxTtl')}</option>
              {renderTtlOptions(ENROLLMENT_TTL_OPTIONS)}
            </select>
            <InheritanceLine fieldId="defaults.maxEnrollmentLinkTtlMinutes" />
            <p className="text-xs text-muted-foreground">
              {t('partnerDefaults.enrollment.maxTtlHint')}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('partnerDefaults.enrollment.maxTtlWarning')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
