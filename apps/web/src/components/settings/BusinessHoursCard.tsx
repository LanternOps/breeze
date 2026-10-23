import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { BusinessCalendarDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims } from '../../lib/authScope';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, ActionError } from '@/lib/runAction';
import { useHashState } from '@/lib/useHashState';
import BusinessHoursForm from './BusinessHoursForm';
import BusinessHoursHolidays from './BusinessHoursHolidays';
import BusinessHoursApplyDialog from './BusinessHoursApplyDialog';
import { WEEKDAY_ORDER, weekFromCalendar } from './businessHoursModel';

const HASH_PREFIX = 'priorities/';

type Mode = { kind: 'idle' } | { kind: 'create' } | { kind: 'edit' };

/**
 * Business hours (#8973): the calendars SLA deadlines are counted on. Lives on the
 * Priorities & SLAs tab because it feeds the same response/resolution clocks.
 */
/**
 * The calendar routes are partner/system scope only, so an organization-scope
 * session gets no card at all rather than a load error and a dead Create.
 */
export default function BusinessHoursCard() {
  if (getJwtClaims().scope === 'organization') return null;
  return <BusinessHoursCardContent />;
}

function BusinessHoursCardContent() {
  const { t } = useTranslation('settings');
  const organizations = useOrgStore((s) => s.organizations);
  const claims = getJwtClaims();
  const forcedOrgId = claims.scope === 'organization' ? claims.orgId ?? null : null;

  const [calendars, setCalendars] = useState<BusinessCalendarDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Selected calendar lives in the URL hash (`#priorities/<id>`), alongside the tab id.
  const [selectedId, setSelectedId] = useHashState<string | null>(null, (hash) =>
    hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) || undefined : undefined,
  );

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/business-calendars?includeArchived=true');
      if (!res.ok) throw new Error(`business calendars load failed: ${res.status}`);
      const body = (await res.json()) as { data: BusinessCalendarDto[] };
      setCalendars(body.data ?? []);
    } catch (err) {
      console.warn('[BusinessHoursCard] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const orgName = useMemo(() => {
    const map = new Map(organizations.map((o) => [o.id, o.name]));
    return (id: string | null) => (id ? map.get(id) ?? null : null);
  }, [organizations]);

  const select = (id: string | null) => {
    window.location.hash = id ? `${HASH_PREFIX}${id}` : 'priorities';
    setSelectedId(id);
    setMode({ kind: 'idle' });
  };

  const selected = calendars.find((c) => c.id === selectedId) ?? null;

  const friendly = (code: string): string | undefined => {
    if (code === 'CALENDAR_IN_USE') return t('businessHoursCard.errors.inUse');
    if (code === 'CALENDAR_IS_DEFAULT') return t('businessHoursCard.errors.isDefault');
    return undefined;
  };

  /** One mutation through runAction with the standard catch pattern. Resolves true on success. */
  const perform = async (url: string, method: string, body: unknown, successMessage: string, errorFallback: string): Promise<boolean> => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
        errorFallback,
        successMessage,
        friendly,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await load();
      return true;
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return false;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: errorFallback });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const hoursLines = (calendar: BusinessCalendarDto) => {
    const week = weekFromCalendar(calendar);
    return WEEKDAY_ORDER.map((d) => ({
      weekday: d,
      text: week[d].length ? week[d].map((r) => `${r.start}–${r.end}`).join(', ') : t('businessHoursCard.closed'),
    }));
  };

  return (
    <section className="mt-10 max-w-3xl" data-testid="business-hours-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('businessHoursCard.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('businessHoursCard.description')}</p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="business-hours-new-tickets-banner">
            {t('businessHoursCard.newTicketsOnly')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMode({ kind: 'create' })}
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          data-testid="business-hours-create"
        >
          {t('businessHoursCard.create')}
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {mode.kind === 'create' && (
          <BusinessHoursForm
            calendar={null}
            orgs={organizations}
            forcedOrgId={forcedOrgId}
            onCancel={() => setMode({ kind: 'idle' })}
            onSaved={(id) => { setMode({ kind: 'idle' }); void load(); if (id) select(id); }}
          />
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="business-hours-loading">{t('businessHoursCard.loading')}</p>
        ) : loadError ? (
          <p className="text-sm text-muted-foreground" data-testid="business-hours-load-error">
            {t('businessHoursCard.loadError')}{' '}
            <button type="button" className="underline" onClick={() => void load()} data-testid="business-hours-retry">{t('businessHoursCard.retry')}</button>
          </p>
        ) : calendars.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="business-hours-empty">{t('businessHoursCard.empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="business-hours-list">
            {calendars.map((c) => {
              const partnerWide = c.ownerScope === 'partner';
              const owner = partnerWide ? null : orgName(c.orgId);
              return (
                <li key={c.id} data-testid={`business-hours-row-${c.id}`}>
                  <button
                    type="button"
                    onClick={() => select(c.id === selectedId ? null : c.id)}
                    aria-expanded={c.id === selectedId}
                    className={`flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 ${c.archivedAt ? 'opacity-60' : ''}`}
                    data-testid={`business-hours-select-${c.id}`}
                  >
                    <span className="font-medium">{c.name}</span>
                    {partnerWide && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs" data-testid={`business-hours-all-orgs-${c.id}`}>
                        {t('businessHoursCard.allOrgs')}
                      </span>
                    )}
                    {owner && <span className="text-xs text-muted-foreground">{owner}</span>}
                    {c.isPartnerDefault && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary" data-testid={`business-hours-default-${c.id}`}>
                        {t('businessHoursCard.default')}
                      </span>
                    )}
                    {c.archivedAt && (
                      <span className="rounded-full border px-2 py-0.5 text-xs" data-testid={`business-hours-archived-${c.id}`}>
                        {t('businessHoursCard.archived')}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{c.currentRevision?.timezone}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && (
          <div className="space-y-4 rounded-md border p-4" data-testid="business-hours-detail">
            {mode.kind === 'edit' ? (
              <BusinessHoursForm
                key={selected.id}
                calendar={selected}
                orgs={organizations}
                forcedOrgId={forcedOrgId}
                onCancel={() => setMode({ kind: 'idle' })}
                onSaved={() => { setMode({ kind: 'idle' }); void load(); }}
              />
            ) : (
              <>
                <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm" data-testid="business-hours-summary">
                  {hoursLines(selected).map((l) => (
                    <div key={l.weekday} className="contents">
                      <dt className="text-muted-foreground">{t(/* i18n-dynamic */ `businessHoursCard.weekdays.${l.weekday}`)}</dt>
                      <dd>{l.text}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={() => setMode({ kind: 'edit' })} className="rounded-md border px-3 py-1.5 text-sm" data-testid="business-hours-edit">
                    {t('businessHoursCard.edit')}
                  </button>
                  {selected.ownerScope === 'partner' && !selected.archivedAt && !selected.isPartnerDefault && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void perform(`/business-calendars/${selected.id}/default`, 'POST', undefined, t('businessHoursCard.toasts.defaultSet'), t('businessHoursCard.errors.default'))}
                      className="rounded-md border px-3 py-1.5 text-sm"
                      data-testid="business-hours-set-default"
                    >
                      {t('businessHoursCard.setDefault')}
                    </button>
                  )}
                  {selected.isPartnerDefault && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void perform('/business-calendars/default', 'DELETE', undefined, t('businessHoursCard.toasts.defaultCleared'), t('businessHoursCard.errors.default'))}
                      className="rounded-md border px-3 py-1.5 text-sm"
                      data-testid="business-hours-clear-default"
                    >
                      {t('businessHoursCard.clearDefault')}
                    </button>
                  )}
                  <button type="button" disabled={busy || !!selected.archivedAt} onClick={() => setApplyOpen(true)} className="rounded-md border px-3 py-1.5 text-sm" data-testid="business-hours-apply-open">
                    {t('businessHoursCard.applyOpen')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void perform(
                      `/business-calendars/${selected.id}/archive`, 'POST', { archived: !selected.archivedAt },
                      selected.archivedAt ? t('businessHoursCard.toasts.unarchived') : t('businessHoursCard.toasts.archived'),
                      t('businessHoursCard.errors.archive'),
                    )}
                    className="rounded-md border px-3 py-1.5 text-sm"
                    data-testid="business-hours-archive"
                  >
                    {selected.archivedAt ? t('businessHoursCard.unarchive') : t('businessHoursCard.archive')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setDeleteOpen(true)} className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive" data-testid="business-hours-delete">
                    {t('businessHoursCard.delete')}
                  </button>
                </div>
                <BusinessHoursHolidays calendar={selected} onChanged={() => void load()} />
              </>
            )}
          </div>
        )}
      </div>

      {selected && (
        <BusinessHoursApplyDialog
          calendarId={selected.id}
          calendarName={selected.name}
          open={applyOpen}
          onClose={() => setApplyOpen(false)}
          onApplied={() => void load()}
        />
      )}
      <ConfirmDialog
        open={deleteOpen && !!selected}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (!selected) return;
          void perform(`/business-calendars/${selected.id}`, 'DELETE', undefined, t('businessHoursCard.toasts.deleted'), t('businessHoursCard.errors.delete'))
            .then((ok) => { setDeleteOpen(false); if (ok) select(null); });
        }}
        title={t('businessHoursCard.deleteTitle', { name: selected?.name ?? '' })}
        message={t('businessHoursCard.deleteMessage')}
        confirmLabel={t('businessHoursCard.delete')}
        isLoading={busy}
        confirmTestId="business-hours-delete-confirm"
      />
    </section>
  );
}
