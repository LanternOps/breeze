import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { FLOW_STEP_DEFAULTS, type FlowDocumentV1, type FlowStepSummary } from '@breeze/shared';
import { useHashState } from '@/lib/useHashState';
import { cn } from '@/lib/utils';

const STEP_HASH_PREFIX = 'step-';

function parseStepHash(hash: string): string | null | undefined {
  return hash.startsWith(STEP_HASH_PREFIX) ? hash.slice(STEP_HASH_PREFIX.length) : undefined;
}

type BuiltinDisplayTool =
  | 'notify' | 'http_request' | 'ai'
  // W06 (#5221): the legacy-conversion built-ins.
  | 'run_script_on_targets' | 'resolve_targets' | 'create_alert';

const BUILTIN_DISPLAY_TOOLS: ReadonlySet<string> = new Set<BuiltinDisplayTool>([
  'notify', 'http_request', 'ai', 'run_script_on_targets', 'resolve_targets', 'create_alert',
]);

function isBuiltinDisplayTool(tool: string): tool is BuiltinDisplayTool {
  return BUILTIN_DISPLAY_TOOLS.has(tool);
}

type FleetSelector =
  | { kind: 'target'; type: string }
  | { kind: 'conditions' }
  | { kind: 'triggerDevice' }
  | { kind: 'devices'; count: number }
  | { kind: 'fromStep'; stepId: string; set: string }
  | { kind: 'unknown' };

/** Which device set a fleet built-in reads (exactly one of target / conditions / deviceIds / fromStep). */
function fleetSelector(data: Record<string, unknown>): FleetSelector {
  const target = data.target as { type?: unknown } | undefined;
  if (target && typeof target.type === 'string') return { kind: 'target', type: target.type };
  if (data.conditions !== undefined) return { kind: 'conditions' };
  if (Array.isArray(data.deviceIds)) {
    return data.deviceIds.length === 1 && String(data.deviceIds[0]).includes('trigger.device')
      ? { kind: 'triggerDevice' }
      : { kind: 'devices', count: data.deviceIds.length };
  }
  const from = data.fromStep as { stepId?: unknown; set?: unknown } | undefined;
  if (from && typeof from.stepId === 'string' && typeof from.set === 'string') {
    return { kind: 'fromStep', stepId: from.stepId, set: from.set };
  }
  return { kind: 'unknown' };
}

function SelectorLine({ selector }: { selector: FleetSelector }) {
  const { t } = useTranslation('flows');
  switch (selector.kind) {
    case 'target':
      return <div>{t(/* i18n-dynamic */ `step.fleet.target.${['all', 'devices', 'groups', 'filter'].includes(selector.type) ? selector.type : 'other'}`)}</div>;
    case 'conditions':
      return <div>{t('step.fleet.conditions')}</div>;
    case 'triggerDevice':
      return <div>{t('step.fleet.triggerDevice')}</div>;
    case 'devices':
      return <div>{t('step.fleet.devices', { count: selector.count })}</div>;
    case 'fromStep':
      return (
        <div>
          {t(/* i18n-dynamic */ `step.fleet.fromStep.${['succeeded', 'dispatched', 'failed'].includes(selector.set) ? selector.set : 'dispatched'}`, { stepId: selector.stepId })}
        </div>
      );
    default:
      return null;
  }
}

/** `https://host/path?q` -> `https://host`; anything not a parsable literal URL is shown raw. */
function urlOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function topLevelFields(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as { properties?: unknown }).properties;
  return props && typeof props === 'object' && !Array.isArray(props) ? Object.keys(props) : [];
}

/** What a W5 built-in step does, at a glance (#5220). Reads the literal input; no lookups. */
function BuiltinStepSummary({ stepId, tool, input }: { stepId: string; tool: BuiltinDisplayTool; input: unknown }) {
  const { t } = useTranslation('flows');
  const data = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const tools = Array.isArray(data.tools) ? data.tools.filter((x): x is string => typeof x === 'string') : [];
  const fields = topLevelFields(data.output);
  return (
    <div className="mt-2 space-y-0.5 text-xs" data-testid={`flow-step-builtin-${stepId}`}>
      <div className="font-medium">{t(/* i18n-dynamic */ `step.builtin.${tool}`)}</div>
      {tool === 'notify' && typeof data.channelId === 'string' && (
        <div className="font-mono">{t('step.notify.channel', { channel: data.channelId })}</div>
      )}
      {tool === 'http_request' && (
        <>
          <div className="font-mono">
            {t('step.http.request', { method: String(data.method ?? ''), origin: urlOrigin(data.url), interpolation: { escapeValue: false } })}
          </div>
          <div className="text-muted-foreground">{t('step.http.anonymous')}</div>
        </>
      )}
      {tool === 'run_script_on_targets' && (
        <>
          <div className="font-mono">{t('step.fleet.script', { scriptId: String(data.scriptId ?? '') })}</div>
          <SelectorLine selector={fleetSelector(data)} />
          <div className="text-muted-foreground">
            {data.whenOffline === 'skip' ? t('step.fleet.offlineSkip') : t('step.fleet.offlineQueue')}
          </div>
        </>
      )}
      {tool === 'resolve_targets' && <SelectorLine selector={fleetSelector(data)} />}
      {tool === 'create_alert' && (
        <div>{t('step.fleet.alert', { severity: String(data.severity ?? '') })}</div>
      )}
      {tool === 'ai' && (
        <>
          <div>{tools.length > 0 ? t('step.ai.tools', { tools: tools.join(', ') }) : t('step.ai.noTools')}</div>
          {fields.length > 0 && <div>{t('step.ai.output', { fields: fields.join(', ') })}</div>}
        </>
      )}
    </div>
  );
}

/**
 * Ordered, read-only list of a flow's steps (#5218). The selected step lives in
 * `window.location.hash` (`#step-<id>`) per the web URL-state rule, so a link
 * from the issues panel — or a pasted URL — lands on the right step.
 *
 * `compact` (the chat card) shows only tool + tier + approval and does not
 * touch the hash: a chat transcript can hold many cards and must not fight
 * over the page URL.
 */
export function FlowStepList({
  steps,
  summaries,
  compact = false,
  preApprovedStepIds = [],
}: {
  steps: FlowDocumentV1['steps'];
  summaries: FlowStepSummary[];
  compact?: boolean;
  /** Steps pre-approved on the live publication (#5219). */
  preApprovedStepIds?: string[];
}) {
  const { t } = useTranslation('flows');
  const [hashSelected, setSelected] = useHashState<string | null>(null, parseStepHash);
  const selected = compact ? null : hashSelected;
  const byId = new Map(summaries.map((s) => [s.id, s]));

  return (
    <ol className="space-y-2" data-testid="flow-steps">
      {steps.map((step, index) => {
        const summary = byId.get(step.id);
        const tier = summary?.tier ?? null;
        const approval = summary?.approval ?? step.approval;
        const isSelected = selected === step.id;
        return (
          <li
            key={step.id}
            id={compact ? undefined : `${STEP_HASH_PREFIX}${step.id}`}
            data-testid={`flow-step-${step.id}`}
            aria-current={isSelected ? 'true' : undefined}
            className={cn('rounded-md border p-3 text-sm', isSelected && 'border-primary bg-primary/5')}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{index + 1}.</span>
              {compact ? (
                <span className="font-mono text-xs">{step.id}</span>
              ) : (
                <button
                  type="button"
                  data-testid={`flow-step-${step.id}-select`}
                  className="font-mono text-xs font-medium hover:underline"
                  onClick={() => {
                    window.location.hash = `${STEP_HASH_PREFIX}${step.id}`;
                    setSelected(step.id);
                  }}
                >
                  {step.id}
                </button>
              )}
              <span className="font-medium" data-testid={`flow-step-${step.id}-tool`}>{step.tool}</span>
              {summary && (
                <span
                  data-testid={`flow-step-${step.id}-source`}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {t(/* i18n-dynamic */ `step.source.${summary.source}`)}
                </span>
              )}
              {tier !== null && (
                <span
                  data-testid={`flow-step-${step.id}-tier`}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium"
                >
                  {t('step.tier', { tier })}
                </span>
              )}
              {preApprovedStepIds.includes(step.id) && (
                <span
                  data-testid={`flow-step-${step.id}-preapproved`}
                  className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
                >
                  {t('step.preApprovedBadge')}
                </span>
              )}
              <span className="text-xs text-muted-foreground" data-testid={`flow-step-${step.id}-approval`}>
                {approval === 'pre_approved' ? t('step.approvalPreApproved') : t('step.approvalDefault')}
              </span>
            </div>
            {isBuiltinDisplayTool(step.tool) && (
              <BuiltinStepSummary stepId={step.id} tool={step.tool} input={step.input} />
            )}
            {!compact && (
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                {step.when && (
                  <div>
                    <dt className="text-muted-foreground">{t('step.when')}</dt>
                    <dd className="font-mono">{step.when}</dd>
                  </div>
                )}
                {step.forEach && (
                  <div>
                    <dt className="text-muted-foreground">{t('step.forEach')}</dt>
                    <dd className="font-mono">{step.forEach.items}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">{t('step.onFailure')}</dt>
                  <dd className="font-mono" data-testid={`flow-step-${step.id}-on-failure`}>
                    {step.onFailure ?? FLOW_STEP_DEFAULTS.onFailure}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('step.timeout')}</dt>
                  <dd className="font-mono" data-testid={`flow-step-${step.id}-timeout`}>
                    {step.timeoutSec ?? FLOW_STEP_DEFAULTS.timeoutSec}s
                  </dd>
                </div>
              </dl>
            )}
            {!compact && (
              <details className="mt-2" data-testid={`flow-step-${step.id}-input`}>
                <summary className="cursor-pointer text-xs text-muted-foreground">{t('step.input')}</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(step.input, null, 2)}
                </pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
