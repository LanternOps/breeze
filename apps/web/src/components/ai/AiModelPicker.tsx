import { useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EFFORT_LEVELS, type EffortLevel } from '@breeze/shared';
import { useAiModelPickerStore } from '@/stores/aiModelPickerStore';
import { useAiStore } from '@/stores/aiStore';
import { formatCentsPerM, formatContextTokens } from './modelPickerFormat';

const NO_ALTERNATIVES: string[] = [];

/**
 * Spec §11 "Chat composer": model menu + the options the chosen model supports.
 * `row` (default) is its own bordered row above the composer; `inline` is one
 * muted line inside the composer box, under the text (the docked pane, #critique).
 */
export default function AiModelPicker({ disabled, variant = 'row' }: { disabled?: boolean; variant?: 'row' | 'inline' }) {
  const { t } = useTranslation('ai');
  const [open, setOpen] = useState(false);
  const { choices, select, setOption, effective } = useAiModelPickerStore();
  const refusalAlternatives = useAiStore((s) => s.refusalAlternatives ?? NO_ALTERNATIVES);
  if (!choices || !choices.allowUserChoice || choices.choices.length === 0) return null;

  const { offeringId, options } = effective();
  const chosen = choices.choices.find((c) => c.offeringId === offeringId) ?? null;

  const inline = variant === 'inline';
  const effortLabel = t('aiModelPicker.effort');

  return (
    <div
      className={inline
        ? 'flex items-center gap-1 pt-1 text-xs text-muted-foreground'
        : 'flex flex-wrap items-center gap-2 border-t px-3 pt-2 text-xs'}
      data-testid="ai-model-picker"
    >
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="ai-model-picker-button"
          className={inline
            ? 'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50'
            : 'flex items-center gap-1 rounded border px-2 py-1 hover:bg-muted disabled:opacity-50'}
        >
          {chosen?.displayName ?? t('aiModelPicker.chooseModel')}
          <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <ul role="listbox" className="absolute bottom-full left-0 z-20 mb-1 w-80 rounded-md border bg-popover p-1 shadow-md">
            {choices.choices.map((c) => {
              const context = formatContextTokens(c.contextTokens);
              const price = t('aiModelPicker.price', {
                input: formatCentsPerM(c.priceHint.inputCentsPerM),
                output: formatCentsPerM(c.priceHint.outputCentsPerM),
              });
              const gated = c.disabled !== null;
              return (
                <li
                  key={c.offeringId}
                  role="option"
                  aria-selected={c.offeringId === offeringId}
                  aria-disabled={gated}
                  data-testid={`ai-model-option-${c.offeringId}`}
                  onClick={() => { if (!gated) { select(c.offeringId); setOpen(false); } }}
                  className={`flex cursor-pointer flex-col rounded px-2 py-1.5 ${gated ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted'}`}
                >
                  <span className="flex items-center gap-1 font-medium">
                    {gated && <Lock className="h-3 w-3" />}
                    {c.displayName}
                    {c.offeringId === choices.defaultOfferingId && (
                      <span className="text-muted-foreground">{t('aiModelPicker.default')}</span>
                    )}
                    {refusalAlternatives.includes(c.offeringId) && (
                      <span className="rounded bg-primary/10 px-1 text-primary">{t('aiModelPicker.suggested')}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {[context ? t('aiModelPicker.context', { size: context }) : null, price].filter(Boolean).join(' · ')}
                  </span>
                  {gated && (
                    <span className="text-muted-foreground">
                      {c.disabled!.roleNames.length > 0
                        ? t('aiModelPicker.requiresRole', { roles: c.disabled!.roleNames.join(', ') })
                        : t('aiModelPicker.requiresPermission')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {chosen && chosen.options.effort.length > 0 && (
        <label className="flex items-center gap-1">
          {inline ? <span aria-hidden="true">·</span> : effortLabel}
          <select
            disabled={disabled}
            value={options.effort ?? ''}
            onChange={(e) => setOption('effort', (e.target.value || undefined) as EffortLevel | undefined)}
            data-testid="ai-model-effort"
            aria-label={inline ? effortLabel : undefined}
            title={inline ? effortLabel : undefined}
            className={inline
              ? 'cursor-pointer rounded bg-transparent px-1 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50'
              : 'rounded border bg-background px-1 py-0.5'}
          >
            <option value="">{t('aiModelPicker.effortDefault')}</option>
            {EFFORT_LEVELS.filter((e) => chosen.options.effort.includes(e)).map((e) => (
              <option key={e} value={e}>{t(/* i18n-dynamic */ `aiModelPicker.effortLevels.${e}`)}</option>
            ))}
          </select>
        </label>
      )}

      {chosen && chosen.options.speed.includes('fast') && chosen.priceHint.fast && (
        <label className="flex items-center gap-1" data-testid="ai-model-fast">
          <input
            type="checkbox"
            disabled={disabled}
            checked={options.speed === 'fast'}
            onChange={(e) => setOption('speed', e.target.checked ? 'fast' : 'standard')}
          />
          {t('aiModelPicker.fast', {
            input: formatCentsPerM(chosen.priceHint.fast.inputCentsPerM),
            output: formatCentsPerM(chosen.priceHint.fast.outputCentsPerM),
          })}
        </label>
      )}

      {chosen && chosen.options.budgetThinking && (
        <label className="flex items-center gap-1" data-testid="ai-model-thinking">
          <input
            type="checkbox"
            disabled={disabled}
            checked={options.budgetThinking === 'on'}
            onChange={(e) => setOption('budgetThinking', e.target.checked ? 'on' : 'off')}
          />
          {t('aiModelPicker.thinking')}
        </label>
      )}
    </div>
  );
}
