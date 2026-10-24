import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { BusinessCalendarDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import TimezoneSelect from '@/components/shared/TimezoneSelect';
import { runAction, ActionError } from '@/lib/runAction';
import BusinessHoursWeekEditor from './BusinessHoursWeekEditor';
import { defaultWeek, weekFromCalendar, weekToIntervals, type WeekDraft } from './businessHoursModel';

type OrgOption = { id: string; name: string };

type Props = {
  /** null = create. */
  calendar: BusinessCalendarDto | null;
  orgs: OrgOption[];
  /** Org-scoped callers can only create calendars for their own org; no owner selector. */
  forcedOrgId: string | null;
  onSaved: (id: string | null) => void;
  onCancel: () => void;
};

export default function BusinessHoursForm({ calendar, orgs, forcedOrgId, onSaved, onCancel }: Props) {
  const { t } = useTranslation('settings');
  const editing = calendar !== null;
  const [name, setName] = useState(calendar?.name ?? '');
  const [timezone, setTimezone] = useState(calendar?.currentRevision?.timezone ?? 'UTC');
  const [week, setWeek] = useState<WeekDraft>(() => (calendar ? weekFromCalendar(calendar) : defaultWeek()));
  // Owner scope is chosen once, at creation — never editable afterwards.
  const [ownerScope, setOwnerScope] = useState<'partner' | 'organization'>(forcedOrgId ? 'organization' : 'partner');
  const [orgId, setOrgId] = useState(forcedOrgId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (name.trim() === '') { setError(t('businessHoursCard.errors.nameRequired')); return; }
    if (!editing && ownerScope === 'organization' && !orgId) { setError(t('businessHoursCard.errors.orgRequired')); return; }
    const parsed = weekToIntervals(week, timezone);
    if (!parsed.ok) { setError(t(/* i18n-dynamic */ `businessHoursCard.errors.${parsed.problem}`)); return; }
    setError(null);

    let body: Record<string, unknown>;
    if (editing) {
      body = {};
      if (name.trim() !== calendar.name) body.name = name.trim();
      const before = calendar.currentRevision;
      const sameHours = before
        && before.timezone === timezone
        && JSON.stringify(before.intervals.map((i) => [i.weekday, i.startMinute, i.endMinute]).sort())
          === JSON.stringify(parsed.intervals.map((i) => [i.weekday, i.startMinute, i.endMinute]).sort());
      if (!sameHours) { body.timezone = timezone; body.intervals = parsed.intervals; }
      if (Object.keys(body).length === 0) { onCancel(); return; }
    } else {
      body = {
        ownerScope, name: name.trim(), timezone, intervals: parsed.intervals,
        ...(ownerScope === 'organization' ? { orgId } : {}),
      };
    }

    setSaving(true);
    try {
      const result = await runAction<{ data: { id: string } }>({
        request: () => fetchWithAuth(editing ? `/business-calendars/${calendar.id}` : '/business-calendars', {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        }),
        errorFallback: t('businessHoursCard.errors.save'),
        successMessage: editing ? t('businessHoursCard.toasts.updated') : t('businessHoursCard.toasts.created'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onSaved(result.data?.id ?? calendar?.id ?? null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('businessHoursCard.errors.save') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-md border p-4" data-testid="business-hours-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="business-hours-name" className="text-sm font-medium">{t('businessHoursCard.name')}</label>
          <input
            id="business-hours-name"
            type="text"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            data-testid="business-hours-name"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="business-hours-timezone" className="text-sm font-medium">{t('businessHoursCard.timezone')}</label>
          <TimezoneSelect
            id="business-hours-timezone"
            label={t('businessHoursCard.timezone')}
            value={timezone}
            onChange={setTimezone}
            testId="business-hours-timezone"
          />
        </div>
        {!editing && !forcedOrgId && (
          <>
            <div className="space-y-1">
              <label htmlFor="business-hours-owner-scope" className="text-sm font-medium">{t('businessHoursCard.appliesTo')}</label>
              <select
                id="business-hours-owner-scope"
                value={ownerScope}
                onChange={(e) => setOwnerScope(e.target.value as 'partner' | 'organization')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                data-testid="business-hours-owner-scope"
              >
                <option value="partner">{t('businessHoursCard.ownerPartner')}</option>
                <option value="organization">{t('businessHoursCard.ownerOrg')}</option>
              </select>
            </div>
            {ownerScope === 'organization' && (
              <div className="space-y-1">
                <label htmlFor="business-hours-org" className="text-sm font-medium">{t('businessHoursCard.organization')}</label>
                <select
                  id="business-hours-org"
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  data-testid="business-hours-org"
                >
                  <option value="">{t('businessHoursCard.chooseOrg')}</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
            )}
          </>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">{t('businessHoursCard.weeklyHours')}</h4>
        <BusinessHoursWeekEditor week={week} onChange={setWeek} disabled={saving} />
      </div>

      <p className="text-xs text-muted-foreground" data-testid="business-hours-new-tickets-note">
        {t('businessHoursCard.newTicketsOnly')}
      </p>

      {error && <p className="text-sm text-destructive" role="alert" data-testid="business-hours-form-error">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="business-hours-save"
        >
          {saving ? t('businessHoursCard.saving') : t('businessHoursCard.save')}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1.5 text-sm" data-testid="business-hours-cancel">
          {t('businessHoursCard.cancel')}
        </button>
      </div>
    </div>
  );
}
