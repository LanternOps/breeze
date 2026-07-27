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

  const autoEnrollment = data.autoEnrollment ?? { enabled: false, requireApproval: true, sendWelcome: true };

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
          <label className="text-sm font-medium">{t('partnerDefaults.updatePolicy')}</label>
          <select
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
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.maintenanceWindow')}</label>
          <input
            type="text"
            value={maintenanceWindow}
            onChange={e => set({ maintenanceWindow: e.target.value || undefined })}
            placeholder={t('partnerDefaults.maintenancePlaceholder')}
            aria-invalid={maintenanceWindowInvalid}
            className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
              maintenanceWindowInvalid ? 'border-destructive' : ''
            }`}
          />
          {maintenanceWindowInvalid ? (
            <p className="text-xs text-destructive">
              <Trans i18nKey="partnerDefaults.maintenanceInvalid" t={t} components={{ first: <code />, second: <code />, always: <code /> }} />
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
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
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.deviceGroup')}</label>
          <input
            type="text"
            value={data.deviceGroup ?? ''}
            onChange={e => set({ deviceGroup: e.target.value || undefined })}
            placeholder={t('partnerDefaults.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.alertThreshold')}</label>
          <input
            type="text"
            value={data.alertThreshold ?? ''}
            onChange={e => set({ alertThreshold: e.target.value || undefined })}
            placeholder={t('partnerDefaults.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      </div>

      {/* Auto-enrollment */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.title')}</p>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, enabled: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.enable')}</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, requireApproval: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.requireApproval')}</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.sendWelcome}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, sendWelcome: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.sendWelcome')}</label>
          </div>
        </div>
      </div>

      {/* Enrollment link defaults + the partner-only lifetime cap (#2776) */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">{t('partnerDefaults.enrollment.title')}</p>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="partner-enrollment-ttl" className="text-sm font-medium">
              {t('partnerDefaults.enrollment.ttl')}
            </label>
            <select
              id="partner-enrollment-ttl"
              data-testid="partner-enrollment-ttl"
              value={data.defaultEnrollmentTtlMinutes ?? ''}
              onChange={e => set({
                defaultEnrollmentTtlMinutes: e.target.value ? Number(e.target.value) : undefined,
              })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('partnerDefaults.notSet')}</option>
              {renderTtlOptions(
                enrollmentTtlOptionsIncluding(partnerCap, data.defaultEnrollmentTtlMinutes),
              )}
            </select>
            <p className="text-xs text-muted-foreground">
              {t('partnerDefaults.enrollment.ttlHint')}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="partner-enrollment-device-count" className="text-sm font-medium">
              {t('partnerDefaults.enrollment.deviceCount')}
            </label>
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
            <p className="text-xs text-muted-foreground">
              {t('partnerDefaults.enrollment.deviceCountHint')}
            </p>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="partner-max-enrollment-ttl" className="text-sm font-medium">
              {t('partnerDefaults.enrollment.maxTtl')}
            </label>
            <select
              id="partner-max-enrollment-ttl"
              data-testid="partner-max-enrollment-ttl"
              value={data.maxEnrollmentLinkTtlMinutes ?? ''}
              onChange={e => set({
                maxEnrollmentLinkTtlMinutes: e.target.value ? Number(e.target.value) : undefined,
              })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:max-w-xs"
            >
              <option value="">{t('partnerDefaults.notSet')}</option>
              {renderTtlOptions(ENROLLMENT_TTL_OPTIONS)}
            </select>
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
