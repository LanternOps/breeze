import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowFormOnFailure } from '@breeze/shared';
import type { ChannelOption } from './ActionsSection';

/**
 * What happens when a script can't be sent to a device (dispatch failed or
 * the device was offline under "skip"): stop, continue with the rest, or
 * send a notice to the chosen channels and stop. This is not "the script
 * exited non-zero". In notify mode the channel list is never empty and never
 * repeats a channel.
 *
 * Choosing Notify creates the summary notice (one per channel for each script
 * that had failures, #12596). A flow that already carries the per-device
 * notice (moved from a Job) keeps it: changing its channels never rewrites the
 * shape, and the help text describes the notice the flow actually sends.
 */
export function OnFailureSection({
  onFailure,
  onChange,
  channels,
  readOnly = false,
}: {
  onFailure: FlowFormOnFailure;
  onChange: (onFailure: FlowFormOnFailure) => void;
  channels: ChannelOption[];
  readOnly?: boolean;
}) {
  const { t } = useTranslation('flows');
  const selected = onFailure.mode === 'notify' ? Array.from(new Set(onFailure.channelIds)) : [];
  const notice = onFailure.mode === 'notify' ? onFailure.notice : 'summary';

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id];
    if (next.length === 0) return; // notify mode never has an empty channel list
    onChange({ mode: 'notify', channelIds: next, notice });
  };

  const radio = (mode: FlowFormOnFailure['mode'], label: string, help: string, disabled = false) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name="flow-onfailure"
        checked={onFailure.mode === mode}
        disabled={readOnly || disabled}
        data-testid={`flow-form-onfailure-${mode}`}
        onChange={() => {
          if (mode === 'notify') {
            if (channels.length > 0) onChange({ mode: 'notify', channelIds: [channels[0].id], notice: 'summary' });
          } else {
            onChange({ mode });
          }
        }}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground" data-testid={`flow-form-onfailure-${mode}-help`}>{help}</span>
      </span>
    </label>
  );

  return (
    <section className="space-y-3" data-testid="flow-form-onfailure">
      <h2 className="text-sm font-semibold" data-testid="flow-form-onfailure-label">{t('flowEditor.form.onFailure.title')}</h2>
      <div className="space-y-2">
        {radio('stop', t('flowEditor.form.onFailure.stop'), t('flowEditor.form.onFailure.stopHelp'))}
        {radio('continue', t('flowEditor.form.onFailure.continue'), t('flowEditor.form.onFailure.continueHelp'))}
        {radio(
          'notify',
          t('flowEditor.form.onFailure.notify'),
          notice === 'perDevice' ? t('flowEditor.form.onFailure.notifyHelp') : t('flowEditor.form.onFailure.notifySummaryHelp'),
          channels.length === 0,
        )}
      </div>
      {channels.length === 0 && <p className="text-xs text-muted-foreground">{t('flowEditor.form.onFailure.noChannels')}</p>}
      {onFailure.mode === 'notify' && (
        <fieldset className="space-y-1 pl-6" data-testid="flow-form-onfailure-channels">
          {channels.map((c) => {
            const checked = selected.includes(c.id);
            return (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readOnly || (checked && selected.length === 1)}
                  data-testid={`flow-form-onfailure-channel-${c.id}`}
                  onChange={() => toggle(c.id)}
                />
                {c.name} ({c.type})
              </label>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}
