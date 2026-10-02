import { useTranslation } from 'react-i18next';
import type { AiTurnModel } from '@breeze/shared';

/** W05, spike constraint 5: the model and options that ACTUALLY ran the last turn. */
export default function AiTurnModelBadge({ turnModel }: { turnModel: AiTurnModel | null | undefined }) {
  const { t } = useTranslation('ai');
  if (!turnModel) return null;
  const effort = turnModel.appliedOptions.effort;
  return (
    <div className="px-3 pt-1 text-[11px] text-muted-foreground" data-testid="ai-turn-model">
      {t('aiTurnModel.answeredBy', { model: turnModel.servedDisplayName })}
      {effort && <> · {t(/* i18n-dynamic */ `aiModelPicker.effortLevels.${effort}`)}</>}
      {turnModel.appliedOptions.speed === 'fast' && <> · {t('aiTurnModel.fast')}</>}
      {turnModel.appliedOptions.budgetThinking === 'on' && <> · {t('aiModelPicker.thinking')}</>}
      {turnModel.fallbackUsed && (
        <span data-testid="ai-turn-model-fallback"> · {t('aiTurnModel.fellBack', { requested: turnModel.requestedDisplayName })}</span>
      )}
      {turnModel.fastDowngraded && (
        <span data-testid="ai-turn-model-fast-downgraded"> · {t('aiTurnModel.fastDowngraded')}</span>
      )}
    </div>
  );
}
