/**
 * One Recipe Library card (Operator Recipe Library W06 R1b, spec §4.1).
 *
 * Three claims the card makes, kept apart because each is read differently:
 *  - the readiness chip — `readiness` alone, three distinct labels;
 *  - the Setup block — ONLY `missingCapabilities` (what this tenant can fix),
 *    each with its server-sent action; and
 *  - the "N steps will be done by hand" line — `manualStepCount` /
 *    `alwaysManualCapabilities`, product gaps with no action and no warning
 *    styling, because there is nothing for the reader to fix.
 * The "what will be done by hand" detail lists `degradedEffects` as sent.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import '@/lib/i18n';
import type { AiOperatorMissingCapabilityDto, AiOperatorWorkflowDto } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { addToolsToAgent, fetchAgentSummary } from '@/lib/api/aiOperatorWorkflows';
import { effectToolLabel } from './operatorTaskLabels';

export interface RecipeCardProps {
  workflow: AiOperatorWorkflowDto;
  /** Called when the primary action is pressed. Omitted for recipes the Library cannot start. */
  onStart?: (workflow: AiOperatorWorkflowDto) => void;
  /** Called after a setup action changed something the readiness depends on. */
  onChanged?: () => void;
}

type T = ReturnType<typeof useTranslation>['t'];

function recipeName(t: T, w: AiOperatorWorkflowDto): string {
  switch (w.recipeKey) {
    case 'identity_offboarding': return t('recipeLibrary.recipe.identityOffboardingName');
    case 'service_recovery': return t('recipeLibrary.recipe.serviceRecoveryName');
    default: return w.name;
  }
}

function recipeSummary(t: T, w: AiOperatorWorkflowDto): string {
  switch (w.recipeKey) {
    case 'identity_offboarding': return t('recipeLibrary.recipe.identityOffboardingSummary');
    case 'service_recovery': return t('recipeLibrary.recipe.serviceRecoverySummary');
    default: return w.summary;
  }
}

function readinessLabel(t: T, readiness: AiOperatorWorkflowDto['readiness']): string {
  switch (readiness) {
    case 'ready': return t('recipeLibrary.readiness.ready');
    case 'setup_required': return t('recipeLibrary.readiness.setupRequired');
    case 'unavailable': return t('recipeLibrary.readiness.unavailable');
    default: return readiness;
  }
}

const CHIP_CLASS: Record<AiOperatorWorkflowDto['readiness'], string> = {
  ready: 'border-success/40 bg-success/10 text-success',
  setup_required: 'border-warning/40 bg-warning/10 text-warning',
  unavailable: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

/**
 * Why the start button is disabled. The capabilities whose absence makes the
 * recipe unavailable are the ones that do NOT degrade to human work; a recipe
 * switched off for the deployment reports no gaps at all.
 */
function unavailableReason(t: T, w: AiOperatorWorkflowDto): string {
  const blocking = w.missingCapabilities.filter((c) => !c.degradesToHumanWork).map((c) => c.detail);
  return blocking.length > 0 ? blocking.join(' ') : t('recipeLibrary.start.notEnabled');
}

/** Only identity_offboarding has a Library-launched form; service_recovery needs a device. */
function startLabel(t: T, w: AiOperatorWorkflowDto): string | null {
  return w.recipeKey === 'identity_offboarding' ? t('recipeLibrary.start.offboard') : null;
}

function useAgentName(agentId: string | null): { name: string | null; allOrgs: boolean } {
  const [state, setState] = useState<{ name: string | null; allOrgs: boolean }>({ name: null, allOrgs: false });
  useEffect(() => {
    if (!agentId) return undefined;
    let live = true;
    fetchAgentSummary(agentId).then(
      (a) => { if (live) setState({ name: a.name, allOrgs: a.allOrgs }); },
      (err: unknown) => { console.warn('[RecipeCard] agent name read failed', err); },
    );
    return () => { live = false; };
  }, [agentId]);
  return state;
}

function AddAgentToolsAction({ capability, fallbackAgentId, onChanged }: {
  capability: AiOperatorMissingCapabilityDto;
  fallbackAgentId: string | null;
  onChanged?: () => void;
}) {
  const { t } = useTranslation('aiOperator');
  const agentId = capability.action.agentId ?? fallbackAgentId;
  const agent = useAgentName(agentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentLabel = agent.name ?? t('recipeLibrary.action.agentFallback');
  const toolNames = capability.action.toolNames;
  if (!agentId || toolNames.length === 0) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await runAction({
        request: () => addToolsToAgent(agentId, toolNames),
        errorFallback: t('recipeLibrary.action.allowToolsFailed'),
        successMessage: t('recipeLibrary.action.allowToolsSuccess', { agent: agentLabel }),
        friendly: (code, _message, body) => {
          if (code === 'MFA_REQUIRED') return t('recipeLibrary.action.mfaRequired');
          if (code === 'AGENT_TOOL_ALLOWLIST_FULL') {
            const limit = (body as { limit?: number } | undefined)?.limit ?? 300;
            return t('recipeLibrary.action.allowlistFull', { limit });
          }
          return undefined;
        },
      });
      onChanged?.();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('recipeLibrary.action.allowToolsFailed') });
        setError(t('recipeLibrary.action.allowToolsFailed'));
        return;
      }
      // Already toasted by runAction; keep the reason on the card too, so an
      // MFA step-up or a full allowlist is not gone when the toast fades.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-muted-foreground">
        {agent.allOrgs
          ? t('recipeLibrary.action.allowToolsScopeAllOrgs', { agent: agentLabel })
          : t('recipeLibrary.action.allowToolsScope', { agent: agentLabel })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('recipeLibrary.action.allowToolsList')}{' '}
        <span className="font-mono">{toolNames.join(', ')}</span>
      </p>
      <button
        type="button"
        data-testid={`recipe-missing-action-${capability.key}`}
        disabled={busy}
        onClick={() => void submit()}
        className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        {t('recipeLibrary.action.allowTools', { count: toolNames.length, agent: agentLabel })}
      </button>
      {error && (
        <p role="alert" data-testid={`recipe-missing-error-${capability.key}`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function capabilityInstruction(t: T, c: AiOperatorMissingCapabilityDto): string | null {
  switch (c.action.kind) {
    case 'reconsent_m365': return t('recipeLibrary.action.reconsentM365');
    case 'connect_google': return t('recipeLibrary.action.connectGoogle');
    case 'connect_m365': return t('recipeLibrary.action.connectM365');
    default: return null;
  }
}

function MissingCapabilityRow({ capability, fallbackAgentId, onChanged }: {
  capability: AiOperatorMissingCapabilityDto;
  fallbackAgentId: string | null;
  onChanged?: () => void;
}) {
  const { t } = useTranslation('aiOperator');
  const instruction = capabilityInstruction(t, capability);
  return (
    <li data-testid={`recipe-missing-${capability.key}`} className="rounded-md border px-3 py-2 text-sm">
      <p>{capability.detail}</p>
      {capability.action.kind === 'add_agent_tools' ? (
        <AddAgentToolsAction capability={capability} fallbackAgentId={fallbackAgentId} onChanged={onChanged} />
      ) : instruction && (
        <p className="mt-1 text-xs text-muted-foreground">
          {instruction}
          {/* The server owns deep links; a null href means "no link", never a guessed URL. */}
          {capability.action.href && (
            <>
              {' '}
              <a
                href={capability.action.href}
                data-testid={`recipe-missing-action-${capability.key}`}
                className="font-medium text-primary underline"
              >
                {t('recipeLibrary.action.open')}
              </a>
            </>
          )}
        </p>
      )}
    </li>
  );
}

export default function RecipeCard({ workflow, onStart, onChanged }: RecipeCardProps) {
  const { t } = useTranslation('aiOperator');
  const [manualOpen, setManualOpen] = useState(false);
  const key = workflow.recipeKey;
  const start = startLabel(t, workflow);
  const unavailable = workflow.readiness === 'unavailable';

  return (
    <article data-testid={`recipe-card-${key}`} className="space-y-3 rounded-lg border bg-card p-4 shadow-xs">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{recipeName(t, workflow)}</h3>
          <p className="text-sm text-muted-foreground">{recipeSummary(t, workflow)}</p>
        </div>
        <span
          data-testid={`recipe-readiness-${key}`}
          className={cn('inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium', CHIP_CLASS[workflow.readiness])}
        >
          {readinessLabel(t, workflow.readiness)}
        </span>
      </header>

      {workflow.missingCapabilities.length > 0 && (
        <section data-testid={`recipe-setup-${key}`} className="space-y-2">
          <h4 className="text-sm font-semibold">{t('recipeLibrary.setupBlock.title')}</h4>
          <p className="text-xs text-muted-foreground">{t('recipeLibrary.setupBlock.description')}</p>
          <ul className="space-y-2">
            {workflow.missingCapabilities.map((c) => (
              <MissingCapabilityRow key={c.key} capability={c} fallbackAgentId={workflow.agentId} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}

      {workflow.manualStepCount > 0 && (
        <section className="text-sm text-muted-foreground">
          <p data-testid={`recipe-manual-count-${key}`}>
            {t('recipeLibrary.manualSteps.count', { count: workflow.manualStepCount })}
          </p>
          <button
            type="button"
            data-testid={`recipe-manual-expand-${key}`}
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((o) => !o)}
            className="mt-1 inline-flex items-center gap-1 text-xs underline"
          >
            {manualOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            {manualOpen ? t('recipeLibrary.manualSteps.collapse') : t('recipeLibrary.manualSteps.expand')}
          </button>
          {manualOpen && (
            <div className="mt-2 space-y-1">
              <p className="text-xs">{t('recipeLibrary.manualSteps.explainer')}</p>
              <ul className="list-disc space-y-1 pl-5">
                {workflow.alwaysManualCapabilities.map((c) => (
                  <li key={c.key} data-testid={`recipe-manual-${c.key}`}>{c.detail}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {workflow.degradedEffects.length > 0 && (
        <details data-testid={`recipe-degraded-${key}`} className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('recipeLibrary.degraded.title')}</summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('recipeLibrary.degraded.description')}</p>
          <ul className="mt-1 list-disc pl-5">
            {workflow.degradedEffects.map((tool) => <li key={tool}>{effectToolLabel(t, tool)}</li>)}
          </ul>
        </details>
      )}

      <footer>
        {start && onStart ? (
          <button
            type="button"
            data-testid={`recipe-start-${key}`}
            disabled={unavailable}
            title={unavailable ? unavailableReason(t, workflow) : undefined}
            onClick={() => onStart(workflow)}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {start}
          </button>
        ) : (
          <p className="text-xs text-muted-foreground">{t('recipeLibrary.start.fromDeviceOrAlert')}</p>
        )}
        {unavailable && start && (
          <p data-testid={`recipe-unavailable-reason-${key}`} className="mt-1 text-xs text-muted-foreground">
            {unavailableReason(t, workflow)}
          </p>
        )}
      </footer>
    </article>
  );
}
