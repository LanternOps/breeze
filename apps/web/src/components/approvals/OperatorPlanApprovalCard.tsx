import { useTranslation } from 'react-i18next';

/**
 * Full, frozen scope of an AI Operator plan approval (actionToolName
 * 'operator_plan'). Every effect is listed — grouped by provider, in dispatch
 * order, with the target/principal labels captured when the plan was frozen —
 * because one approval authorizes up to 64 effects and the approver must be
 * able to read all of them before signing. Presentational only: no fetch, no
 * mutation (approve/deny stay on the inbox's existing buttons).
 */
export type OperatorPlanProvider = 'breeze' | 'm365' | 'google';

export interface OperatorPlanEffect {
  ordinal: number;
  provider: OperatorPlanProvider;
  toolName: string;
  targetLabel: string;
  principalLabel: string | null;
  rendering: string;
}

export interface OperatorPlanArgs {
  taskId?: string;
  planRevision?: number;
  effectSetDigest?: string;
  effects?: unknown;
}

export const OPERATOR_PLAN_TOOL_NAME = 'operator_plan';

export function isOperatorPlanApproval(actionToolName: string | null | undefined): boolean {
  return actionToolName === OPERATOR_PLAN_TOOL_NAME;
}

// Stable group order so two renders of the same plan never differ.
const PROVIDER_ORDER: readonly OperatorPlanProvider[] = ['breeze', 'm365', 'google'];

const GROUP_KEY: Record<OperatorPlanProvider, string> = {
  breeze: 'operatorPlan.groupBreeze',
  m365: 'operatorPlan.groupM365',
  google: 'operatorPlan.groupGoogle',
};

function isProvider(value: unknown): value is OperatorPlanProvider {
  return value === 'breeze' || value === 'm365' || value === 'google';
}

/** Returns null when ANY entry is malformed: a partially-rendered plan would let an approver sign what they could not fully see. */
function parseEffects(value: unknown): OperatorPlanEffect[] | null {
  if (!Array.isArray(value)) return null;
  const out: OperatorPlanEffect[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    if (
      typeof e.ordinal !== 'number' || !Number.isFinite(e.ordinal) ||
      !isProvider(e.provider) ||
      typeof e.targetLabel !== 'string' ||
      typeof e.rendering !== 'string' ||
      (e.principalLabel !== null && e.principalLabel !== undefined && typeof e.principalLabel !== 'string')
    ) {
      return null;
    }
    out.push({
      ordinal: e.ordinal,
      provider: e.provider,
      toolName: typeof e.toolName === 'string' ? e.toolName : '',
      targetLabel: e.targetLabel,
      principalLabel: typeof e.principalLabel === 'string' ? e.principalLabel : null,
      rendering: e.rendering,
    });
  }
  return out;
}

/**
 * True only when the plan payload is fully parseable AND lists at least one
 * effect — i.e. the card can show the approver everything they would sign.
 * The inbox gates Approve on this so the card and the button share one
 * definition of "readable" (deny is never gated).
 */
export function isOperatorPlanReadable(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const effects = parseEffects((args as OperatorPlanArgs).effects);
  return effects !== null && effects.length > 0;
}

export default function OperatorPlanApprovalCard({ args }: { args: OperatorPlanArgs | Record<string, unknown> | null | undefined }) {
  const { t } = useTranslation('approvals');
  const a = (args ?? {}) as OperatorPlanArgs;
  const effects = parseEffects(a.effects);
  const revision = typeof a.planRevision === 'number' ? a.planRevision : '—';

  const shell = 'mt-3 max-w-3xl rounded-md border p-3 text-sm';

  if (effects === null) {
    return (
      <div className={shell} data-testid="operator-plan-empty">
        <p className="font-medium">{t('operatorPlan.title')}</p>
        <p className="mt-2 text-destructive">{t('operatorPlan.invalid')}</p>
      </div>
    );
  }
  if (effects.length === 0) {
    return (
      <div className={shell} data-testid="operator-plan-empty">
        <p className="font-medium">{t('operatorPlan.title')}</p>
        <p className="mt-2 text-muted-foreground">{t('operatorPlan.empty')}</p>
      </div>
    );
  }

  return (
    <div className={shell}>
      <p className="font-medium">{t('operatorPlan.title')}</p>
      <p className="mt-1 text-muted-foreground" data-testid="operator-plan-summary">
        {t('operatorPlan.summary', { count: effects.length, revision })}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t('operatorPlan.orderNote')}</p>
      {PROVIDER_ORDER.map((provider) => {
        const group = effects.filter((e) => e.provider === provider).sort((x, y) => x.ordinal - y.ordinal);
        if (group.length === 0) return null;
        return (
          <section key={provider} className="mt-3" data-testid={`operator-plan-group-${provider}`}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(/* i18n-dynamic */ GROUP_KEY[provider])}
            </h4>
            <ol className="mt-1 space-y-2">
              {group.map((effect) => (
                <li
                  key={effect.ordinal}
                  className="rounded border bg-muted/30 p-2"
                  data-testid={`operator-plan-effect-${effect.ordinal}`}
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('operatorPlan.effectOrdinal', { ordinal: effect.ordinal + 1 })}
                  </p>
                  <p className="mt-0.5 break-words text-foreground/90">{effect.rendering}</p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {effect.principalLabel
                      ? t('operatorPlan.targetLine', {
                          targetLabel: effect.targetLabel,
                          principalLabel: effect.principalLabel,
                          interpolation: { escapeValue: false },
                        })
                      : effect.targetLabel}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
