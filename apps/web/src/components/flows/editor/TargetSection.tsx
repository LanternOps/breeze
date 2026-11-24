import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { DeploymentTargetConfig, FlowFormTarget, FlowFormTrigger } from '@breeze/shared';
import { DeviceTargetSelector } from '../../filters/DeviceTargetSelector';

/**
 * Where the script and alert actions run. An event trigger always targets the
 * device that raised the event (for every listed event type, as converted
 * Jobs do), so the picker is hidden. A partner-wide flow is offered only "all"
 * and "filter": the validator refuses a literal device or an organization's
 * group in a partner-wide flow.
 */
export function TargetSection({
  trigger,
  target,
  onChange,
  partnerWide,
  orgId,
  readOnly = false,
  needsChoice,
  onConfirm,
}: {
  trigger: FlowFormTrigger;
  target: FlowFormTarget;
  onChange: (target: FlowFormTarget) => void;
  partnerWide: boolean;
  orgId?: string;
  readOnly?: boolean;
  /** A device action was just added to a flow that had none: the default target must be chosen, not assumed. */
  needsChoice: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('flows');

  if (trigger.type === 'event') {
    return (
      <section className="space-y-2" data-testid="flow-form-target">
        <h2 className="text-sm font-semibold">{t('flowEditor.form.target.title')}</h2>
        <p className="text-sm text-muted-foreground" data-testid="flow-form-target-trigger-device">{t('flowEditor.form.target.triggerDevice')}</p>
      </section>
    );
  }

  const value: DeploymentTargetConfig = target.kind === 'target' ? target.target : { type: 'all' };
  return (
    <section className="space-y-2" data-testid="flow-form-target">
      <h2 className="text-sm font-semibold">{t('flowEditor.form.target.title')}</h2>
      {needsChoice && !readOnly && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm" data-testid="flow-form-target-choose">
          <span>{t('flowEditor.form.target.choose')}</span>
          <button type="button" className="rounded border px-2 py-0.5 text-xs" data-testid="flow-form-target-confirm" onClick={onConfirm}>
            {t('flowEditor.form.target.keep')}
          </button>
        </div>
      )}
      {partnerWide && <p className="text-xs text-muted-foreground">{t('flowEditor.form.target.partnerWide')}</p>}
      {readOnly ? (
        <pre className="rounded border bg-muted/40 p-2 text-xs" data-testid="flow-form-target-readonly">{JSON.stringify(value, null, 2)}</pre>
      ) : (
        <DeviceTargetSelector
          value={value}
          onChange={(next) => onChange({ kind: 'target', target: next })}
          modes={partnerWide ? ['all', 'filter'] : ['all', 'manual', 'groups', 'filter']}
          orgId={partnerWide ? undefined : orgId}
          flagRefusedGroups
        />
      )}
    </section>
  );
}
