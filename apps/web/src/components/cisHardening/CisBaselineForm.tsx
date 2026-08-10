import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Loader2, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, ActionError } from '@/lib/runAction';
import type { Baseline } from './types';
import HelpTooltip from '../shared/HelpTooltip';

interface CisBaselineFormProps {
  baseline: Baseline | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CisBaselineForm({ baseline, onClose, onSaved }: CisBaselineFormProps) {
  const { t } = useTranslation('security');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [name, setName] = useState(baseline?.name ?? '');
  const [osType, setOsType] = useState(baseline?.osType ?? 'windows');
  const [level, setLevel] = useState(baseline?.level ?? 'l1');
  const [benchmarkVersion, setBenchmarkVersion] = useState(baseline?.benchmarkVersion ?? '');
  const [scheduleEnabled, setScheduleEnabled] = useState(baseline?.scanSchedule?.enabled ?? false);
  const [intervalHours, setIntervalHours] = useState(baseline?.scanSchedule?.intervalHours ?? 24);
  const [isActive, setIsActive] = useState(baseline?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [saving, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);

    try {
      const body: Record<string, unknown> = {
        name,
        osType,
        level,
        benchmarkVersion,
        isActive,
        scanSchedule: {
          enabled: scheduleEnabled,
          intervalHours: scheduleEnabled ? intervalHours : undefined,
        },
      };
      // The org has to travel in the BODY. `fetchWithAuth` auto-appends the
      // selected org to the URL, but POST /cis/baselines reads its org only
      // from the validated JSON body and requires an explicit one whenever the
      // token isn't org-scoped — so a multi-org partner used to get a hard 400
      // here while the query string quietly carried the right answer.
      //
      // On edit, send the baseline's OWN org rather than the header selection:
      // the route looks the row up by (id, orgId), so a mismatch is a 404 — or
      // a 403 if the caller can't reach that org at all.
      const targetOrgId = baseline?.orgId ?? currentOrgId;
      if (targetOrgId) body.orgId = targetOrgId;
      if (baseline?.id) {
        body.id = baseline.id;
      }

      await runAction({
        request: () => fetchWithAuth('/cis/baselines', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        errorFallback: t('cisHardeningCisBaselineForm.messages.saveFailed'),
        successMessage: t('cisHardeningCisBaselineForm.messages.saveSuccess', { name }),
      });

      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // runAction already toasted the failure; keep the inline copy too — the
      // modal stays open on failure and the banner is where the user is looking.
      setError(err instanceof Error ? err.message : t('cisHardeningCisBaselineForm.messages.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {baseline
              ? t('cisHardeningCisBaselineForm.title.edit')
              : t('cisHardeningCisBaselineForm.title.new')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="bl-name" className="block text-sm font-medium mb-1.5">{t('cisHardeningCisBaselineForm.fields.name')}</label>
            <input
              id="bl-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="bl-os" className="block text-sm font-medium mb-1.5">{t('cisHardeningCisBaselineForm.fields.osType')}</label>
            <select
              id="bl-os"
              value={osType}
              onChange={(e) => setOsType(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
            >
              <option value="windows">{t('cisHardeningCisBaselineForm.os.windows')}</option>
              <option value="macos">{t('cisHardeningCisBaselineForm.os.macos')}</option>
              <option value="linux">{t('cisHardeningCisBaselineForm.os.linux')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="bl-level" className="block text-sm font-medium mb-1.5">
              {t('cisHardeningCisBaselineForm.fields.level')}
              <HelpTooltip text={t('cisHardeningCisBaselineForm.tooltips.level')} />
            </label>
            <select
              id="bl-level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
            >
              <option value="l1">{t('cisHardeningCisBaselineForm.levels.l1')}</option>
              <option value="l2">{t('cisHardeningCisBaselineForm.levels.l2')}</option>
              <option value="custom">{t('cisHardeningCisBaselineForm.levels.custom')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="bl-version" className="block text-sm font-medium mb-1.5">{t('cisHardeningCisBaselineForm.fields.benchmarkVersion')}</label>
            <input
              id="bl-version"
              type="text"
              required
              value={benchmarkVersion}
              onChange={(e) => setBenchmarkVersion(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
              placeholder={t('cisHardeningCisBaselineForm.placeholders.benchmarkVersion')}
            />
          </div>

          <div className="flex items-center gap-3">
            <input
              id="bl-schedule"
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <label htmlFor="bl-schedule" className="text-sm font-medium">{t('cisHardeningCisBaselineForm.fields.enableScheduledScans')}</label>
            {scheduleEnabled && (
              <input
                type="number"
                min={1}
                max={168}
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                className="w-20 rounded-md border bg-background px-2 py-1 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
              />
            )}
            {scheduleEnabled && <span className="text-sm text-muted-foreground">{t('cisHardeningCisBaselineForm.hours')}</span>}
          </div>

          <div className="flex items-center gap-3">
            <input
              id="bl-active"
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <label htmlFor="bl-active" className="text-sm font-medium">{t('cisHardeningCisBaselineForm.fields.active')}</label>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('cisHardeningCisBaselineForm.actions.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('cisHardeningCisBaselineForm.actions.saving')}
                </>
              ) : (
                t('cisHardeningCisBaselineForm.actions.save')
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
