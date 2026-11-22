import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowFormTrigger, FlowIssue } from '@breeze/shared';
import { getEventTypeOptions } from '../../automations/AutomationForm';

type TriggerType = FlowFormTrigger['type'];
const TRIGGER_TYPES: readonly TriggerType[] = ['schedule', 'event', 'webhook', 'manual'];

type FilterValue = string | number | boolean;

/** The default trigger of each type when the person switches to it. */
export function defaultTrigger(type: TriggerType, previous: FlowFormTrigger): FlowFormTrigger {
  switch (type) {
    case 'schedule':
      return previous.type === 'schedule' ? previous : { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' };
    case 'event':
      return previous.type === 'event' ? previous : { type: 'event', event: 'device.offline', filter: {} };
    case 'webhook':
      return previous.type === 'webhook' ? previous : { type: 'webhook', auth: 'hmac' };
    case 'manual':
      return { type: 'manual' };
  }
}

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';

/**
 * Trigger: a schedule (cron and time zone), an event (type and a scalar
 * equality filter), a webhook (HMAC or token; a partner-wide flow names the
 * body field and system that resolve the organization) or manual only.
 */
export function TriggerSection({
  trigger,
  onChange,
  partnerWide,
  issues,
  readOnly = false,
}: {
  trigger: FlowFormTrigger;
  onChange: (trigger: FlowFormTrigger) => void;
  partnerWide: boolean;
  issues: FlowIssue[];
  readOnly?: boolean;
}) {
  const { t } = useTranslation('flows');
  const { t: ts } = useTranslation('scripts');
  const eventOptions = useMemo(() => getEventTypeOptions(ts), [ts]);
  const eventWarnings = issues.filter((i) => i.code === 'event_dispatch_not_durable');

  const typeLabel = (type: TriggerType) => {
    switch (type) {
      case 'schedule': return ts('automationForm.triggerTypes.schedule.label');
      case 'event': return ts('automationForm.triggerTypes.event.label');
      case 'webhook': return ts('automationForm.triggerTypes.webhook.label');
      case 'manual': return ts('automationForm.triggerTypes.manual.label');
    }
  };

  const filterRows = trigger.type === 'event' ? Object.entries(trigger.filter) : [];
  const setFilter = (rows: Array<[string, FilterValue]>) => {
    if (trigger.type !== 'event') return;
    onChange({ ...trigger, filter: Object.fromEntries(rows) });
  };

  return (
    <section className="space-y-3" data-testid="flow-form-trigger">
      <h2 className="text-sm font-semibold">{t('flowEditor.form.trigger.title')}</h2>
      <div role="radiogroup" className="flex flex-wrap gap-2">
        {TRIGGER_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={trigger.type === type}
            disabled={readOnly}
            data-testid={`flow-form-trigger-${type}`}
            className={trigger.type === type ? 'rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium' : 'rounded-md border px-3 py-1.5 text-sm'}
            onClick={() => onChange(defaultTrigger(type, trigger))}
          >
            {typeLabel(type)}
          </button>
        ))}
      </div>

      {trigger.type === 'schedule' && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">{ts('automationForm.fields.cronExpression')}</span>
            <input className={`${input} font-mono`} value={trigger.cron} disabled={readOnly} data-testid="flow-form-cron" onChange={(e) => onChange({ ...trigger, cron: e.target.value })} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t('flowEditor.form.trigger.timezone')}</span>
            <input className={input} value={trigger.timezone} disabled={readOnly} data-testid="flow-form-timezone" onChange={(e) => onChange({ ...trigger, timezone: e.target.value })} />
          </label>
        </div>
      )}

      {trigger.type === 'event' && (
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{ts('automationForm.fields.eventType')}</span>
            <select className={input} value={trigger.event} disabled={readOnly} data-testid="flow-form-event" onChange={(e) => onChange({ ...trigger, event: e.target.value })}>
              {!eventOptions.some((o) => o.value === trigger.event) && <option value={trigger.event}>{trigger.event}</option>}
              {eventOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">{t('flowEditor.form.trigger.eventDeviceHelp')}</p>
          {eventWarnings.map((w, i) => (
            <p key={`${w.code}-${i}`} role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm" data-testid="flow-editor-event-unavailable">
              {w.message}
            </p>
          ))}
          <div className="space-y-2" data-testid="flow-form-event-filter">
            <p className="text-sm font-medium">{t('flowEditor.form.trigger.filter')}</p>
            <p className="text-xs text-muted-foreground">{t('flowEditor.form.trigger.filterHelp')}</p>
            {filterRows.map(([key, value], i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={`${input} font-mono`}
                  aria-label={t('flowEditor.form.trigger.filterKey')}
                  value={key}
                  disabled={readOnly}
                  data-testid={`flow-form-filter-${i}-key`}
                  onChange={(e) => setFilter(filterRows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                />
                <input
                  className={input}
                  aria-label={t('flowEditor.form.trigger.filterValue')}
                  value={String(value)}
                  disabled={readOnly}
                  data-testid={`flow-form-filter-${i}-value`}
                  onChange={(e) => setFilter(filterRows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                />
                <button type="button" className="rounded border px-2 text-xs" disabled={readOnly} onClick={() => setFilter(filterRows.filter((_, j) => j !== i))}>
                  {t('flowEditor.form.remove')}
                </button>
              </div>
            ))}
            <button type="button" className="rounded border px-2 py-1 text-xs" disabled={readOnly} data-testid="flow-form-filter-add" onClick={() => setFilter([...filterRows, ['', '']])}>
              {t('flowEditor.form.trigger.filterAdd')}
            </button>
          </div>
        </div>
      )}

      {trigger.type === 'webhook' && (
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{t('webhook.authMode.label')}</span>
            <select className={input} value={trigger.auth} disabled={readOnly} data-testid="flow-form-webhook-auth" onChange={(e) => onChange({ ...trigger, auth: e.target.value === 'token' ? 'token' : 'hmac' })}>
              <option value="hmac">{t('webhook.authMode.hmac')}</option>
              <option value="token">{t('webhook.authMode.token')}</option>
            </select>
          </label>
          {partnerWide && (
            <div className="grid gap-3 md:grid-cols-2">
              <p className="text-xs text-muted-foreground md:col-span-2">{t('flowEditor.form.trigger.resolverHelp')}</p>
              <label className="space-y-1 text-sm">
                <span className="font-medium">{t('flowEditor.form.trigger.resolverPath')}</span>
                <input
                  className={`${input} font-mono`}
                  placeholder="body.customer.id"
                  value={trigger.orgResolver?.path ?? ''}
                  disabled={readOnly}
                  data-testid="flow-form-webhook-resolver-path"
                  onChange={(e) => {
                    const system = trigger.orgResolver && 'system' in trigger.orgResolver ? trigger.orgResolver.system : '';
                    onChange({ ...trigger, orgResolver: { path: e.target.value, system } });
                  }}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">{t('flowEditor.form.trigger.resolverSystem')}</span>
                <input
                  className={`${input} font-mono`}
                  value={trigger.orgResolver && 'system' in trigger.orgResolver ? trigger.orgResolver.system : ''}
                  disabled={readOnly}
                  data-testid="flow-form-webhook-resolver-system"
                  onChange={(e) => onChange({ ...trigger, orgResolver: { path: trigger.orgResolver?.path ?? '', system: e.target.value } })}
                />
              </label>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('flowEditor.form.trigger.webhookHelp')}</p>
        </div>
      )}

      {trigger.type === 'manual' && <p className="text-xs text-muted-foreground">{t('flowEditor.form.trigger.manualHelp')}</p>}
    </section>
  );
}
