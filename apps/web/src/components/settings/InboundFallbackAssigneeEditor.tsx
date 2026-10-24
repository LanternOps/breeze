import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ActionError, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import {
  fetchAssigneeCandidates,
  fetchInboundConfig,
  saveInboundConfig,
  type AssigneeOption,
  type InboundConfig,
} from './inboundEmailConfig';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/**
 * "If no rule assigns an email ticket": the partner's inbound default assignee,
 * moved here from InboundEmailCard. Same setting, same wire shape — load and
 * save go through inboundEmailConfig.ts, which sends the COMPLETE
 * ticketing.inbound object (a partial one would destroy the omitted fields).
 * Partner scope only; TicketRoutingTab does not mount this for org users.
 */
export default function InboundFallbackAssigneeEditor() {
  const { t } = useTranslation('settings');
  const [cfg, setCfg] = useState<InboundConfig | null>(null);
  const [candidates, setCandidates] = useState<AssigneeOption[]>([]);
  const [value, setValue] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [config, list] = await Promise.all([fetchInboundConfig(), fetchAssigneeCandidates()]);
      setCfg(config);
      setCandidates(list);
      setValue(config.defaultAssigneeUserId ?? '');
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      // The PATCH replaces the whole inbound object, so build it from a FRESH
      // read: a mount-time snapshot would revert anything saved elsewhere (the
      // Inbound email card) since this editor loaded. A failed read aborts the
      // save rather than falling back to the snapshot.
      const fresh = await fetchInboundConfig();
      const next: InboundConfig = { ...fresh, defaultAssigneeUserId: value || null };
      await saveInboundConfig(next, {
        errorFallback: t('ticketRouting.fallback.saveFailed'),
        successMessage: t('ticketRouting.fallback.saved'),
        friendly: (code) =>
          code === 'DEFAULT_ASSIGNEE_NOT_ASSIGNABLE' ? t('inboundEmail.defaultAssigneeNotAssignable') : undefined,
        onUnauthorized: UNAUTHORIZED,
      });
      setCfg(next);
    } catch (err) {
      if (err instanceof ActionError) return; // runAction already toasted (or the auth redirect owns a 401)
      handleActionError(err, t('ticketRouting.fallback.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const dirty = cfg !== null && value !== (cfg.defaultAssigneeUserId ?? '');

  return (
    <section className="space-y-2 rounded-lg border p-4" data-testid="routing-fallback-assignee">
      <h3 className="text-sm font-semibold">{t('ticketRouting.fallback.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('ticketRouting.fallback.description')}</p>
      {loadFailed ? (
        <p className="text-xs text-muted-foreground" data-testid="routing-fallback-assignee-error">
          {t('ticketRouting.fallback.loadFailed')}{' '}
          <button
            type="button"
            className="underline hover:text-foreground"
            data-testid="routing-fallback-assignee-retry"
            onClick={() => void load()}
          >
            {t('common:actions.retry')}
          </button>
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <div className="grow">
            <label className="block text-xs font-medium" htmlFor="routing-fallback-assignee-select">
              {t('ticketRouting.fallback.label')}
            </label>
            <select
              id="routing-fallback-assignee-select"
              data-testid="routing-fallback-assignee-select"
              className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              value={value}
              disabled={!cfg || saving}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="">{t('common:labels.none')}</option>
              {value && !candidates.some((u) => u.id === value) && (
                <option value={value}>{t('ticketRouting.fallback.unavailable')}</option>
              )}
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            data-testid="routing-fallback-assignee-save"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {t('common:actions.save')}
          </button>
        </div>
      )}
    </section>
  );
}
