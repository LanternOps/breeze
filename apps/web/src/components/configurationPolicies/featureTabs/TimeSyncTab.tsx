import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  TIME_SYNC_DEFAULTS,
  timeSyncInlineSettingsSchema,
} from '@breeze/shared';
import { type FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import TimezoneSelect from '../../shared/TimezoneSelect';
import '@/lib/i18n';
function readSettings(value: unknown) {
  const parsed = timeSyncInlineSettingsSchema.safeParse(
    value ?? TIME_SYNC_DEFAULTS,
  );
  return parsed.success ? parsed.data : timeSyncInlineSettingsSchema.parse({});
}
export default function TimeSyncTab({
  policyId,
  existingLink,
  parentLink,
  linkedPolicyId,
  onLinkChanged,
}: FeatureTabProps) {
  const { t } = useTranslation('devices');
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const initial = readSettings((existingLink ?? parentLink)?.inlineSettings);
  const [enforceNtp, setEnforceNtp] = useState(initial.enforceNtp);
  const [servers, setServers] = useState(initial.ntpServers.join('\n'));
  const [interval, setInterval] = useState(String(initial.pollIntervalMinutes));
  const [expected, setExpected] = useState<'site' | 'pinned'>(
    initial.timezone.expected,
  );
  const [pin, setPin] = useState(initial.timezone.pinnedTimezone ?? '');
  const [autoFix, setAutoFix] = useState(initial.timezone.autoFix);
  useEffect(() => {
    const next = readSettings((existingLink ?? parentLink)?.inlineSettings);
    setEnforceNtp(next.enforceNtp);
    setServers(next.ntpServers.join('\n'));
    setInterval(String(next.pollIntervalMinutes));
    setExpected(next.timezone.expected);
    setPin(next.timezone.pinnedTimezone ?? '');
    setAutoFix(next.timezone.autoFix);
  }, [existingLink, parentLink]);
  const parsed = timeSyncInlineSettingsSchema.safeParse({
    enforceNtp,
    ntpServers: servers
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    pollIntervalMinutes: interval === '' ? NaN : Number(interval),
    timezone: { expected, pinnedTimezone: pin || null, autoFix },
  });
  const inherited = !!parentLink && !existingLink;
  const persist = async (id: string | null) => {
    if (!parsed.success) return;
    clearError();
    const result = await save(id, {
      featureType: 'time_sync',
      featurePolicyId: null,
      inlineSettings: { ...parsed.data },
    });
    if (result) onLinkChanged(result, 'time_sync');
  };
  const discard = async () => {
    if (existingLink && (await remove(existingLink.id)))
      onLinkChanged(null, 'time_sync');
  };
  const errors = parsed.success
    ? []
    : [
        ...new Set(
          parsed.error.issues.map((issue) =>
            issue.path[0] === 'ntpServers'
              ? t('timeSync.management.invalidServers')
              : issue.path[0] === 'pollIntervalMinutes'
                ? t('timeSync.management.invalidInterval')
                : t('timeSync.management.invalidZone'),
          ),
        ),
      ];
  return (
    <FeatureTabShell
      title={t('timeSync.management.title')}
      description={t('timeSync.management.description')}
      icon={<Clock className="h-5 w-5" />}
      isConfigured={!!existingLink || inherited}
      saving={saving}
      saveDisabled={!parsed.success}
      error={error}
      onSave={() => void persist(existingLink?.id ?? null)}
      onRemove={existingLink && !linkedPolicyId ? discard : undefined}
      isInherited={inherited}
      onOverride={inherited ? () => void persist(null) : undefined}
      onRevert={
        !inherited && !!linkedPolicyId && !!existingLink ? discard : undefined
      }
    >
      <p className="mb-4 text-sm text-muted-foreground">
        {t('timeSync.management.domainRule')}
      </p>
      <p className="mb-4 text-sm text-muted-foreground">
        {t('timeSync.management.gpoWins')}
      </p>
      <fieldset disabled={inherited || saving} className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            data-testid="time-sync-enforce-ntp"
            type="checkbox"
            role="switch"
            checked={enforceNtp}
            onChange={(e) => setEnforceNtp(e.target.checked)}
          />
          {t('timeSync.management.enforceNtp')}
        </label>
        <label className="block text-sm">
          {t('timeSync.management.ntpServers')}
          <textarea
            data-testid="time-sync-servers"
            value={servers}
            onChange={(e) => setServers(e.target.value)}
            className="mt-2 block w-full rounded-md border bg-background p-3"
          />
        </label>
        <label className="block text-sm">
          {t('timeSync.management.pollInterval')}
          <input
            data-testid="time-sync-interval"
            type="number"
            min={15}
            max={1440}
            step={1}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            className="mt-2 block h-10 w-full rounded-md border bg-background px-3"
          />
        </label>
        <label className="block text-sm">
          {t('timeSync.management.expectedTimezone')}
          <select
            data-testid="time-sync-expected"
            value={expected}
            onChange={(e) => setExpected(e.target.value as 'site' | 'pinned')}
            className="mt-2 block h-10 w-full rounded-md border bg-background px-3"
          >
            <option value="site">{t('timeSync.management.site')}</option>
            <option value="pinned">{t('timeSync.management.pinned')}</option>
          </select>
        </label>
        {expected === 'pinned' && (
          <>
            <TimezoneSelect
              value={pin}
              onChange={setPin}
              label={t('timeSync.management.pinnedZone')}
              testId="time-sync-pinned-zone"
            />
            <p className="text-sm text-muted-foreground">
              {t('timeSync.management.pinOverrides')}
            </p>
          </>
        )}
        <label className="flex items-center gap-2">
          <input
            data-testid="time-sync-auto-fix"
            type="checkbox"
            role="switch"
            checked={autoFix}
            onChange={(e) => setAutoFix(e.target.checked)}
          />
          {t('timeSync.management.autoFix')}
        </label>
        {errors.length > 0 && (
          <ul role="alert" className="text-sm text-destructive">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </fieldset>
    </FeatureTabShell>
  );
}
