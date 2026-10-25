/**
 * The `identity_onboarding` draft preview (Operator Recipe Library W07 R2b,
 * Task 17): two labelled approval stages, in plan order within each.
 *
 * Stage 1 is what the first approval will create, named by the REQUESTED
 * sign-in name (`principalLabel`) — the approval card itself does not show it
 * yet (R2a "Needs Todd"), so this preview never depends on that card. Stage 2
 * is provisional: its accounts do not exist until stage 1 runs, the draft
 * reads no group, and a licence appears only when the draft saw a free seat.
 * Every draft flag is rendered verbatim with its subject.
 */
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorIdentityOnboardingTaskDraftDto, AiOperatorOnboardingDraftEffectDto } from '@breeze/shared';
import { effectToolLabel, providerLabel } from './operatorTaskLabels';
import { flagLabel } from './StartRecipeOnboardingFields';
import { inPlanOrder } from './onboardingForm';

type Draft = AiOperatorIdentityOnboardingTaskDraftDto;

function argText(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function EffectList({ effects }: { effects: AiOperatorOnboardingDraftEffectDto[] }) {
  const { t } = useTranslation('aiOperator');
  return (
    <ul className="list-disc space-y-1 pl-5">
      {inPlanOrder(effects).map((e) => (
        <li key={`${e.provider}-${e.ordinal}-${e.toolName}`}>
          <span>{effectToolLabel(t, e.toolName)}</span>
          <span className="text-muted-foreground"> · {providerLabel(e.provider)} · {e.principalLabel}</span>
          {Object.keys(e.arguments).length > 0 && (
            <span className="block font-mono text-xs text-muted-foreground">
              {Object.entries(e.arguments).map(([k, v]) => `${k}: ${argText(v)}`).join(' · ')}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function StartRecipeOnboardingPreview({ draft }: { draft: Draft }) {
  const { t } = useTranslation('aiOperator');
  return (
    <section data-testid="start-recipe-preview" className="space-y-3 rounded-md border p-3 text-sm" aria-live="polite">
      <h4 className="font-semibold">{t('startRecipe.preview.title')}</h4>

      <div data-testid="start-recipe-preview-stage-1" className="space-y-1">
        <h5 className="font-medium">{t('startRecipe.onboarding.previewStage1')}</h5>
        {draft.createPlanPreview.length === 0
          ? <p className="text-xs text-muted-foreground">{t('startRecipe.onboarding.previewStage1Empty')}</p>
          : <EffectList effects={draft.createPlanPreview} />}
      </div>

      <div data-testid="start-recipe-preview-stage-2" className="space-y-1">
        <h5 className="font-medium">{t('startRecipe.onboarding.previewStage2')}</h5>
        <p className="text-xs text-muted-foreground">{t('startRecipe.onboarding.previewProvisional')}</p>
        {draft.provisionPlanPreview.length === 0
          ? <p className="text-xs text-muted-foreground">{t('startRecipe.preview.plannedEmpty')}</p>
          : <EffectList effects={draft.provisionPlanPreview} />}
      </div>

      {draft.flags.length > 0 && (
        <div data-testid="start-recipe-preview-flags">
          <h5 className="font-medium">{t('startRecipe.onboarding.flagsTitle')}</h5>
          <ul className="list-disc pl-5">
            {draft.flags.map((f, i) => (
              <li key={`${f.code}-${i}`}><span className="font-medium">{flagLabel(t, f.code)}</span> · <span className="font-mono text-xs">{f.subject}</span> — {f.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {draft.manualWork.length > 0 && (
        <div data-testid="start-recipe-preview-manual">
          <h5 className="font-medium">{t('startRecipe.preview.manualTitle')}</h5>
          <ul className="list-disc pl-5">
            {draft.manualWork.map((item) => <li key={item.key}>{item.label}</li>)}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('startRecipe.onboarding.previewNote')}</p>
    </section>
  );
}
