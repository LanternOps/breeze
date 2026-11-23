import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ALERT_SEVERITIES, deviceCountsSuffix, type FlowFormAction } from '@breeze/shared';

/** The notify and create_alert built-ins' message ceiling (`packages/shared/src/flows/builtins.ts`). */
export const NOTIFY_MESSAGE_MAX = 4000;
const TITLE_MAX = 200;
/** The longest counts line the form appends after a script (two-digit action index). */
const COUNTS_SUFFIX_RESERVE = deviceCountsSuffix('a49_run_script').length;

export interface ScriptOption { id: string; name: string }
export interface ChannelOption { id: string; name: string; type: string }

type ActionType = FlowFormAction['type'];
const ADDABLE: readonly ActionType[] = ['run_script', 'notify', 'create_alert'];
const NOTIFY_SEVERITIES = ['info', 'warning', 'critical'] as const;

export function newAction(type: ActionType, channels: ChannelOption[]): FlowFormAction {
  switch (type) {
    case 'run_script':
      return { type: 'run_script', scriptId: '', whenOffline: 'queue' };
    case 'notify':
      return { type: 'notify', channelId: channels[0]?.id ?? '', title: '', message: '', severity: 'info' };
    case 'create_alert':
      return { type: 'create_alert', severity: 'medium', title: '', message: '' };
  }
}

const field = 'w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';

/**
 * The ordered action list: run a script, send one notification per run, or
 * raise an alert on each device. There is no command action: a command is
 * saved as a script first. Step ids follow the position, so reordering
 * renumbers them.
 */
export function ActionsSection({
  actions,
  onChange,
  scripts,
  channels,
  readOnly = false,
}: {
  actions: FlowFormAction[];
  onChange: (actions: FlowFormAction[]) => void;
  scripts: ScriptOption[];
  channels: ChannelOption[];
  readOnly?: boolean;
}) {
  const { t } = useTranslation('flows');
  const { t: ts } = useTranslation('scripts');

  const replace = (i: number, next: FlowFormAction) => onChange(actions.map((a, j) => (j === i ? next : a)));
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= actions.length) return;
    const next = [...actions];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const typeLabel = (type: ActionType) => {
    switch (type) {
      case 'run_script': return t('flowEditor.form.actions.runScript');
      case 'notify': return t('flowEditor.form.actions.notify');
      case 'create_alert': return t('flowEditor.form.actions.alert');
    }
  };

  return (
    <section className="space-y-3" data-testid="flow-form-actions">
      <h2 className="text-sm font-semibold">{t('flowEditor.form.actions.title')}</h2>
      {actions.length === 0 && <p className="text-sm text-muted-foreground">{t('flowEditor.form.actions.empty')}</p>}
      <ol className="space-y-3">
        {actions.map((action, i) => {
          const afterScript = actions.slice(0, i).some((a) => a.type === 'run_script');
          return (
            <li key={i} className="space-y-3 rounded-md border p-3" data-testid={`flow-form-action-${i}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('flowEditor.form.actions.position', { n: i + 1 })} · {typeLabel(action.type)}</span>
                <div className="flex gap-1">
                  <button type="button" className="rounded border px-2 py-0.5 text-xs" disabled={readOnly || i === 0} aria-label={t('flowEditor.form.actions.moveUp')} data-testid={`flow-form-action-${i}-up`} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="rounded border px-2 py-0.5 text-xs" disabled={readOnly || i === actions.length - 1} aria-label={t('flowEditor.form.actions.moveDown')} data-testid={`flow-form-action-${i}-down`} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="rounded border px-2 py-0.5 text-xs" disabled={readOnly} data-testid={`flow-form-action-${i}-remove`} onClick={() => onChange(actions.filter((_, j) => j !== i))}>{t('flowEditor.form.remove')}</button>
                </div>
              </div>

              {action.type === 'run_script' && (
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="space-y-1 text-sm md:col-span-3">
                    <span className="font-medium">{ts('automationForm.fields.script')}</span>
                    <select className={field} value={action.scriptId} disabled={readOnly} data-testid={`flow-form-action-${i}-script`} onChange={(e) => replace(i, { ...action, scriptId: e.target.value })}>
                      <option value="">{ts('automationForm.placeholders.selectScript')}</option>
                      {action.scriptId && !scripts.some((s) => s.id === action.scriptId) && <option value={action.scriptId}>{action.scriptId}</option>}
                      {scripts.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{ts('automationForm.fields.runAs')}</span>
                    <select
                      className={field}
                      value={action.runAs ?? ''}
                      disabled={readOnly}
                      data-testid={`flow-form-action-${i}-runas`}
                      onChange={(e) => {
                        const { runAs: _drop, ...rest } = action;
                        replace(i, e.target.value === 'system' || e.target.value === 'user' ? { ...rest, runAs: e.target.value } : rest);
                      }}
                    >
                      <option value="">{t('flowEditor.form.actions.runAsDefault')}</option>
                      <option value="system">{t('flowEditor.form.actions.runAsSystem')}</option>
                      <option value="user">{t('flowEditor.form.actions.runAsUser')}</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{ts('automationForm.fields.whenOffline')}</span>
                    <select className={field} value={action.whenOffline} disabled={readOnly} data-testid={`flow-form-action-${i}-offline`} onChange={(e) => replace(i, { ...action, whenOffline: e.target.value === 'skip' ? 'skip' : 'queue' })}>
                      <option value="queue">{ts('automationForm.options.whenOffline.queue')}</option>
                      <option value="skip">{ts('automationForm.options.whenOffline.skip')}</option>
                    </select>
                  </label>
                  <ParametersEditor
                    index={i}
                    parameters={action.parameters ?? {}}
                    readOnly={readOnly}
                    onChange={(parameters) => {
                      const { parameters: _drop, ...rest } = action;
                      replace(i, Object.keys(parameters).length > 0 ? { ...rest, parameters } : rest);
                    }}
                  />
                </div>
              )}

              {action.type === 'notify' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{ts('automationForm.fields.notificationChannel')}</span>
                    <select className={field} value={action.channelId} disabled={readOnly} data-testid={`flow-form-action-${i}-channel`} onChange={(e) => replace(i, { ...action, channelId: e.target.value })}>
                      <option value="">{ts('automationForm.placeholders.selectChannel')}</option>
                      {action.channelId && !channels.some((c) => c.id === action.channelId) && <option value={action.channelId}>{action.channelId}</option>}
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{ts('automationForm.fields.severity')}</span>
                    <select className={field} value={action.severity} disabled={readOnly} data-testid={`flow-form-action-${i}-severity`} onChange={(e) => replace(i, { ...action, severity: NOTIFY_SEVERITIES.find((s) => s === e.target.value) ?? 'info' })}>
                      <option value="info">{t('flowEditor.form.actions.severityInfo')}</option>
                      <option value="warning">{t('flowEditor.form.actions.severityWarning')}</option>
                      <option value="critical">{t('flowEditor.form.actions.severityCritical')}</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-medium">{t('flowEditor.form.actions.title_')}</span>
                    <input className={field} maxLength={TITLE_MAX} value={action.title} disabled={readOnly} data-testid={`flow-form-action-${i}-title`} onChange={(e) => replace(i, { ...action, title: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-medium">{ts('automationForm.fields.message')}</span>
                    <textarea
                      className={field}
                      rows={3}
                      maxLength={afterScript ? NOTIFY_MESSAGE_MAX - COUNTS_SUFFIX_RESERVE : NOTIFY_MESSAGE_MAX}
                      value={action.message}
                      disabled={readOnly}
                      data-testid={`flow-form-action-${i}-message`}
                      onChange={(e) => replace(i, { ...action, message: e.target.value })}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground md:col-span-2">{t('flowEditor.form.actions.notifyHelp')}</p>
                  {afterScript && (
                    <p className="text-xs text-muted-foreground md:col-span-2" data-testid={`flow-form-action-${i}-counts-help`}>{t('flowEditor.form.actions.countsHelp')}</p>
                  )}
                </div>
              )}

              {action.type === 'create_alert' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{ts('automationForm.fields.severity')}</span>
                    <select className={field} value={action.severity} disabled={readOnly} data-testid={`flow-form-action-${i}-severity`} onChange={(e) => replace(i, { ...action, severity: ALERT_SEVERITIES.find((s) => s === e.target.value) ?? 'medium' })}>
                      {ALERT_SEVERITIES.map((s) => (
                        <option key={s} value={s}>{ts(/* i18n-dynamic */ `automationForm.severity.${s}`)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{t('flowEditor.form.actions.title_')}</span>
                    <input className={field} maxLength={TITLE_MAX} value={action.title} disabled={readOnly} data-testid={`flow-form-action-${i}-title`} onChange={(e) => replace(i, { ...action, title: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-medium">{ts('automationForm.fields.message')}</span>
                    <textarea className={field} rows={3} maxLength={NOTIFY_MESSAGE_MAX} value={action.message} disabled={readOnly} data-testid={`flow-form-action-${i}-message`} onChange={(e) => replace(i, { ...action, message: e.target.value })} />
                  </label>
                  <p className="text-xs text-muted-foreground md:col-span-2">{t('flowEditor.form.actions.alertHelp')}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2" data-testid="flow-form-actions-add">
          {ADDABLE.map((type) => (
            <button key={type} type="button" className="rounded border px-3 py-1.5 text-sm" data-testid={`flow-form-add-${type}`} onClick={() => onChange([...actions, newAction(type, channels)])}>
              + {typeLabel(type)}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground" data-testid="flow-form-command-hint">
        {t('flowEditor.form.actions.commandHint')}{' '}
        <a className="text-primary hover:underline" href="/scripts">{t('flowEditor.form.actions.scriptsLink')}</a>
      </p>
    </section>
  );
}

/** Script parameters as name/value rows; values are sent as typed text. */
function ParametersEditor({
  index,
  parameters,
  readOnly,
  onChange,
}: {
  index: number;
  parameters: Record<string, string | number | boolean>;
  readOnly: boolean;
  onChange: (parameters: Record<string, string | number | boolean>) => void;
}) {
  const { t } = useTranslation('flows');
  const rows = Object.entries(parameters);
  const set = (next: Array<[string, string | number | boolean]>) => onChange(Object.fromEntries(next));
  return (
    <div className="space-y-2 md:col-span-3" data-testid={`flow-form-action-${index}-parameters`}>
      <p className="text-sm font-medium">{t('flowEditor.form.actions.parameters')}</p>
      {rows.map(([name, value], j) => (
        <div key={j} className="flex gap-2">
          <input className={`${field} font-mono`} aria-label={t('flowEditor.form.actions.parameterName')} value={name} disabled={readOnly} onChange={(e) => set(rows.map((r, k) => (k === j ? [e.target.value, r[1]] : r)))} />
          <input className={field} aria-label={t('flowEditor.form.actions.parameterValue')} value={String(value)} disabled={readOnly} onChange={(e) => set(rows.map((r, k) => (k === j ? [r[0], e.target.value] : r)))} />
          <button type="button" className="rounded border px-2 text-xs" disabled={readOnly} onClick={() => set(rows.filter((_, k) => k !== j))}>{t('flowEditor.form.remove')}</button>
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => set([...rows, [`PARAM${rows.length + 1}`, '']])}>
          {t('flowEditor.form.actions.parameterAdd')}
        </button>
      )}
    </div>
  );
}
