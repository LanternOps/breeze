import { useTranslation } from 'react-i18next';
import { RESEARCH_EDITABLE_LIMIT_KEYS } from '@breeze/shared';
import type { Draft } from './agentDraft';
import { numberField } from './agentFields';

type ResearchLimitKey = (typeof RESEARCH_EDITABLE_LIMIT_KEYS)[number];

// Mirrors the bounds in packages/shared/src/validators/aiAgents.ts
// (limitsFields); the server is the authority, these only keep the inputs sane.
const BOUNDS: Record<ResearchLimitKey, readonly [min: number, max: number]> = {
  maxConcurrentResearchRuns: [1, 10],
  maxResearchRunsPerHour: [1, 300],
  maxAutoResearchRunsPerHour: [0, 100],
  researchQuickBudgetCentsPerRun: [1, 50],
  researchDeepBudgetCentsPerRun: [1, 200],
  maxBudgetCentsPerDay: [1, 100000],
};

export interface ResearchAgentFieldsProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
}

/**
 * The only agent-specific controls a built-in research agent has (AI Suggested
 * Fixes W2): its spending and rate caps. Everything else about the agent is
 * fixed by its run profile, and the server refuses any other edit
 * (assertResearchAgentEdit).
 */
export default function ResearchAgentFields({ draft, patch }: ResearchAgentFieldsProps) {
  const { t } = useTranslation('settings');
  return (
    <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-research-caps">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('aiAgentsPage.research.capsTitle')}
      </legend>
      <p className="text-xs text-muted-foreground">{t('aiAgentsPage.research.builtInNote')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {RESEARCH_EDITABLE_LIMIT_KEYS.map((key) => (
          <div key={key} className="space-y-1">
            {numberField(
              `ai-agent-research-cap-${key}`,
              t(/* i18n-dynamic */ `aiAgentsPage.research.caps.${key}.label`),
              draft.limits[key],
              BOUNDS[key][0],
              BOUNDS[key][1],
              (value) => patch({ limits: { ...draft.limits, [key]: value } }),
            )}
            <p className="text-xs text-muted-foreground">
              {t(/* i18n-dynamic */ `aiAgentsPage.research.caps.${key}.hint`)}
            </p>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
