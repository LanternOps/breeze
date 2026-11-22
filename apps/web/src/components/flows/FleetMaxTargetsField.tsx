import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { FLEET_MAX_TARGETS } from '@breeze/shared';

/**
 * The user-confirmed device cap of a pre-approved `run_script_on_targets`
 * step: a whole number from 1 to `FLEET_MAX_TARGETS`, otherwise null (the
 * server answers `max_targets_invalid` for anything else).
 */
export function parseFleetMaxTargets(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= FLEET_MAX_TARGETS ? n : null;
}

/**
 * The `maxTargets` input of one ticked fleet pre-approval, with the wording
 * that says what the pre-approval authorizes: devices are resolved on each
 * run, an approver sees the frozen device list, and for a partner-wide flow
 * the limit applies per organization. Shared by the conversion switch and the
 * enable dialog (Flows completion W01c); render it only while the step is ticked.
 */
export function FleetMaxTargetsField({
  stepId,
  value,
  onChange,
  partnerWide,
  testIdPrefix,
  perOrgTestId,
}: {
  stepId: string;
  value: string;
  onChange: (v: string) => void;
  partnerWide: boolean;
  /** The input is `${testIdPrefix}-${stepId}`; the invalid message `${testIdPrefix}-invalid-${stepId}`. */
  testIdPrefix: string;
  perOrgTestId: string;
}) {
  const { t } = useTranslation('flows');
  const invalid = parseFleetMaxTargets(value) === null;
  return (
    <div className="space-y-1 pl-6">
      <label className="flex flex-wrap items-center gap-2 text-xs">
        <span>{t('conversion.switch.maxTargets', { max: FLEET_MAX_TARGETS })}</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={FLEET_MAX_TARGETS}
          required
          aria-invalid={invalid}
          data-testid={`${testIdPrefix}-${stepId}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-24 rounded border bg-background px-2"
        />
      </label>
      {invalid && (
        <p className="text-xs text-destructive" data-testid={`${testIdPrefix}-invalid-${stepId}`}>
          {t('conversion.switch.maxTargetsInvalid', { max: FLEET_MAX_TARGETS })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('conversion.switch.liveMembership')}</p>
      <p className="text-xs text-muted-foreground">{t('conversion.switch.frozenDevices')}</p>
      {partnerWide && (
        <p className="text-xs text-muted-foreground" data-testid={perOrgTestId}>
          {t('conversion.switch.perOrgMultiplies')}
        </p>
      )}
    </div>
  );
}
