import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowFormAction, FlowFormTarget, FlowFormTrigger, FlowFormValues, FlowIssue } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionsSection, type ChannelOption, type ScriptOption } from './ActionsSection';
import { OnFailureSection } from './OnFailureSection';
import { TargetSection } from './TargetSection';
import { TriggerSection } from './TriggerSection';

export interface FlowFormViewProps {
  values: FlowFormValues;
  onChange: (values: FlowFormValues) => void;
  /** The flow is (or will be) owned partner-wide: targets are limited to all and filter. */
  partnerWide: boolean;
  /** Live validation issues, for inline hints (e.g. event delivery not durable). */
  issues: FlowIssue[];
  readOnly?: boolean;
  /** The owning org, to scope pickers. Undefined for a partner-wide flow. */
  orgId?: string;
}

const isDeviceAction = (a: FlowFormAction) => a.type === 'run_script' || a.type === 'create_alert';

/**
 * The target a trigger implies: an event targets the device that raised it;
 * every other trigger needs a real target, so a triggering-device target left
 * over from an event becomes "all devices" (the person is asked to confirm).
 */
export function targetForTrigger(trigger: FlowFormTrigger, target: FlowFormTarget): FlowFormTarget {
  if (trigger.type === 'event') return { kind: 'trigger_device' };
  return target.kind === 'trigger_device' ? { kind: 'target', target: { type: 'all' } } : target;
}

async function readList<T>(path: string, keys: string[]): Promise<T[]> {
  const res = await fetchWithAuth(path);
  if (!res.ok) return [];
  const body = (await res.json()) as Record<string, unknown>;
  for (const k of keys) if (Array.isArray(body[k])) return body[k] as T[];
  return [];
}

/**
 * The guided form (spec §3.1): one trigger, one target, an ordered list of
 * script / notification / alert actions and an on-failure rule. Every change
 * is handed up as values; the editor compiles them into the document.
 */
export function FlowFormView({ values, onChange, partnerWide, issues, readOnly = false, orgId }: FlowFormViewProps) {
  const { t } = useTranslation('flows');
  const { t: ts } = useTranslation('scripts');
  const [scripts, setScripts] = useState<ScriptOption[]>([]);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [listsFailed, setListsFailed] = useState(false);
  // Set when a device action is added to a flow that had none: the target shown is only a default.
  const [targetNeedsChoice, setTargetNeedsChoice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readList<ScriptOption>('/scripts', ['data', 'scripts']),
      readList<ChannelOption>('/alerts/channels', ['data', 'channels']),
    ])
      .then(([s, c]) => {
        if (cancelled) return;
        setScripts(s);
        setChannels(c);
      })
      .catch(() => {
        if (!cancelled) setListsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasDeviceAction = values.actions.some(isDeviceAction);

  const setTrigger = (trigger: FlowFormTrigger) => {
    const target = targetForTrigger(trigger, values.target);
    if (values.target.kind === 'trigger_device' && target.kind === 'target' && hasDeviceAction) setTargetNeedsChoice(true);
    if (trigger.type === 'event') setTargetNeedsChoice(false);
    onChange({ ...values, trigger, target });
  };

  const setActions = (actions: FlowFormAction[]) => {
    if (!hasDeviceAction && actions.some(isDeviceAction) && values.trigger.type !== 'event') setTargetNeedsChoice(true);
    onChange({ ...values, actions });
  };

  const setTarget = (target: FlowFormTarget) => {
    setTargetNeedsChoice(false);
    onChange({ ...values, target });
  };

  const field = 'w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';

  return (
    <fieldset className="space-y-6 rounded-lg border bg-card p-4" disabled={readOnly} data-testid="flow-form-fieldset">
      <div className="grid gap-4 md:grid-cols-2" data-testid="flow-editor-form">
        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('flowEditor.form.name')}</span>
          <input
            className={field}
            maxLength={120}
            value={values.name}
            placeholder={ts('automationForm.placeholders.name')}
            disabled={readOnly}
            data-testid="flow-form-name"
            onChange={(e) => onChange({ ...values, name: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('flowEditor.form.description')}</span>
          <input
            className={field}
            maxLength={2000}
            value={values.description ?? ''}
            disabled={readOnly}
            data-testid="flow-form-description"
            onChange={(e) => {
              const { description: _drop, ...rest } = values;
              onChange(e.target.value ? { ...rest, description: e.target.value } : rest);
            }}
          />
        </label>
      </div>

      {listsFailed && <p className="text-sm text-destructive" data-testid="flow-form-lists-failed">{t('flowEditor.form.listsFailed')}</p>}

      <TriggerSection trigger={values.trigger} onChange={setTrigger} partnerWide={partnerWide} issues={issues} readOnly={readOnly} />

      {hasDeviceAction && (
        <TargetSection
          trigger={values.trigger}
          target={values.target}
          onChange={setTarget}
          partnerWide={partnerWide}
          orgId={orgId}
          readOnly={readOnly}
          needsChoice={targetNeedsChoice}
          onConfirm={() => setTargetNeedsChoice(false)}
        />
      )}

      <ActionsSection actions={values.actions} onChange={setActions} scripts={scripts} channels={channels} readOnly={readOnly} />

      {values.actions.some((a) => a.type === 'run_script') && (
        <OnFailureSection onFailure={values.onFailure} onChange={(onFailure) => onChange({ ...values, onFailure })} channels={channels} readOnly={readOnly} />
      )}
    </fieldset>
  );
}
