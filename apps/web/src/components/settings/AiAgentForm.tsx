import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_AGENT_KINDS, AI_AGENT_LIMIT_DEFAULTS, type AiAgentKind } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { useOrgScope } from '@/hooks/useOrgScope';
import type { OwnerScope } from '@/hooks/useDefaultOwnerScope';

export type AiAgentMode = 'off' | 'shadow' | 'act';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

/** The `mapRow` shape returned by GET/POST/PATCH /ai/agents. */
export interface AiAgentDto {
  id: string;
  kind: AiAgentKind;
  name: string;
  enabled: boolean;
  mode: AiAgentMode;
  orgId: string | null;
  partnerId: string | null;
  ownerScope: OwnerScope;
  allOrgs: boolean;
  /** Modes this API build accepts on write; `act` is absent until wave 4. */
  supportedModes: AiAgentMode[];
  disabledAt: string | null;
  toolAllowlist?: string[] | null;
  protectedResources?: { services?: string[]; paths?: string[]; registryKeys?: string[] } | null;
  limits?: Partial<typeof AI_AGENT_LIMIT_DEFAULTS> | null;
  triggers?: { alertSeverities?: string[]; respectMaintenanceWindows?: boolean } | null;
  recipients?: { userIds?: string[]; roleIds?: string[] } | null;
  instructions?: string | null;
  cooldownSeconds?: number | null;
}

interface RoleOption {
  id: string;
  name: string;
}

interface Props {
  /** null = create a new agent. */
  agent: AiAgentDto | null;
  /** Kinds that already have an active agent in this scope — cannot be created twice. */
  takenKinds: AiAgentKind[];
  /** Show the partner-wide vs org-owned selector (create-only, partner-scope users). */
  showOwnerScope: boolean;
  defaultOwnerScope: OwnerScope;
  onClose: () => void;
  onSaved: () => void;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });
const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';
const INSTRUCTIONS_MAX = 2000;

/** Newline-separated textarea → trimmed, de-duplicated list. */
function lines(value: string): string[] {
  return [...new Set(value.split('\n').map((entry) => entry.trim()).filter(Boolean))];
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

interface Draft {
  ownerScope: OwnerScope;
  kind: AiAgentKind;
  name: string;
  enabled: boolean;
  mode: AiAgentMode;
  severities: Severity[];
  respectMaintenanceWindows: boolean;
  toolAllowlist: string;
  services: string;
  paths: string;
  registryKeys: string;
  limits: typeof AI_AGENT_LIMIT_DEFAULTS;
  cooldownSeconds: number;
  roleIds: string[];
  instructions: string;
}

function draftFrom(
  agent: AiAgentDto | null,
  defaults: { ownerScope: OwnerScope; kind: AiAgentKind },
): Draft {
  const severities = (agent?.triggers?.alertSeverities ?? ['critical', 'high']).filter(
    (severity): severity is Severity => (SEVERITIES as readonly string[]).includes(severity),
  );
  return {
    ownerScope: agent?.ownerScope ?? defaults.ownerScope,
    kind: agent?.kind ?? defaults.kind,
    name: agent?.name ?? '',
    enabled: agent?.enabled ?? false,
    mode: agent?.mode ?? 'off',
    severities,
    respectMaintenanceWindows: agent?.triggers?.respectMaintenanceWindows ?? true,
    toolAllowlist: (agent?.toolAllowlist ?? []).join('\n'),
    services: (agent?.protectedResources?.services ?? []).join('\n'),
    paths: (agent?.protectedResources?.paths ?? []).join('\n'),
    registryKeys: (agent?.protectedResources?.registryKeys ?? []).join('\n'),
    limits: { ...AI_AGENT_LIMIT_DEFAULTS, ...(agent?.limits ?? {}) },
    cooldownSeconds: agent?.cooldownSeconds ?? 900,
    roleIds: agent?.recipients?.roleIds ?? [],
    instructions: agent?.instructions ?? '',
  };
}

/**
 * Create/edit form for one AI agent policy row.
 *
 * `kind` and `ownerScope` are create-only: the API has no update path for
 * either (an agent's identity is `(owner, kind)`, and both unique indexes are
 * partial on `disabled_at IS NULL`), so offering them on edit would promise a
 * change the server cannot make.
 */
export default function AiAgentForm({
  agent,
  takenKinds,
  showOwnerScope,
  defaultOwnerScope,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation('settings');
  const orgScope = useOrgScope();
  const isCreate = agent === null;

  const availableKinds = AI_AGENT_KINDS.filter((kind) => !takenKinds.includes(kind));
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(agent, {
      ownerScope: defaultOwnerScope,
      kind: availableKinds[0] ?? AI_AGENT_KINDS[0],
    }),
  );
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const patch = (values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values }));

  // Recipients are role IDs, never role names: `roles` is a tenant-scoped table
  // with partner-defined names, so the picker has to show the real rows.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetchWithAuth('/roles').catch(() => null);
      if (!response || !response.ok || cancelled) return;
      const body = (await response.json()) as { roles?: RoleOption[]; data?: RoleOption[] };
      if (!cancelled) setRoles(body.roles ?? body.data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    const problems: string[] = [];
    if (!draft.name.trim()) problems.push(t('aiAgentsPage.issues.name'));
    // `alertSeverities` is `.min(1)` server-side — an empty list is not
    // "all severities", it is a 400.
    if (draft.severities.length === 0) problems.push(t('aiAgentsPage.issues.severities'));
    if (isCreate && draft.ownerScope === 'organization' && !orgScope.orgId) {
      problems.push(t('aiAgentsPage.issues.org'));
    }
    if (problems.length > 0) {
      setIssues(problems);
      return;
    }
    setIssues([]);
    setSaving(true);

    // Nested objects are deep-merged onto the stored jsonb server-side, so the
    // narrowing fields this form does not expose (siteIds, deviceGroupIds,
    // deviceTags) survive a save instead of being erased.
    const policy = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      mode: draft.mode,
      triggers: {
        alertSeverities: draft.severities,
        respectMaintenanceWindows: draft.respectMaintenanceWindows,
      },
      toolAllowlist: lines(draft.toolAllowlist),
      protectedResources: {
        services: lines(draft.services),
        paths: lines(draft.paths),
        registryKeys: lines(draft.registryKeys),
      },
      limits: draft.limits,
      cooldownSeconds: draft.cooldownSeconds,
      recipients: { roleIds: draft.roleIds },
      instructions: draft.instructions.trim() ? draft.instructions.trim() : null,
    };

    try {
      await runAction({
        // Inline thunks: the no-silent-mutations guard is a lexical AST check,
        // so a hoisted request function reads as an unwrapped mutation (#2429).
        request: isCreate
          ? () => {
              const body: Record<string, unknown> = {
                ...policy,
                kind: draft.kind,
                ownerScope: draft.ownerScope,
              };
              if (draft.ownerScope === 'organization') body.orgId = orgScope.orgId;
              return fetchWithAuth('/ai/agents', { method: 'POST', body: JSON.stringify(body) });
            }
          : () =>
              fetchWithAuth(`/ai/agents/${agent.id}`, {
                method: 'PATCH',
                body: JSON.stringify(policy),
              }),
        successMessage: t('aiAgentsPage.toasts.saved'),
        errorFallback: t('aiAgentsPage.toasts.saveFailed'),
        onUnauthorized: UNAUTHORIZED
      });
      onSaved();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // runAction already toasted; keep the editor open so the draft survives.
    } finally {
      setSaving(false);
    }
  }, [agent, draft, isCreate, orgScope.orgId, saving, onSaved, t]);

  const disable = useCallback(async () => {
    if (!agent) return;
    if (!confirmDisable) {
      setConfirmDisable(true);
      return;
    }
    setConfirmDisable(false);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/agents/${agent.id}`, { method: 'DELETE' }),
        successMessage: t('aiAgentsPage.toasts.disabled'),
        errorFallback: t('aiAgentsPage.toasts.disableFailed'),
        onUnauthorized: UNAUTHORIZED
      });
      onSaved();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [agent, confirmDisable, onSaved, t]);

  const numberField = (
    testId: string,
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (next: number) => void,
  ) => (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type="number"
        className={inputCls}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
      />
    </label>
  );

  const listField = (
    testId: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
    rows = 3,
  ) => (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        className={`${inputCls} font-mono`}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </label>
  );

  return (
    <section className="rounded-lg border bg-muted/20 p-4" data-testid="ai-agent-editor">
      <h2 className="mb-3 text-sm font-semibold">
        {isCreate ? t('aiAgentsPage.editor.newTitle') : t('aiAgentsPage.editor.editTitle')}
      </h2>

      {issues.length > 0 && (
        <ul
          className="mb-3 list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive"
          data-testid="ai-agent-issues"
        >
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {isCreate && showOwnerScope && (
          <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-ownerscope">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('aiAgentsPage.editor.scopeLegend')}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="ai-agent-owner"
                value="partner"
                checked={draft.ownerScope === 'partner'}
                onChange={() => patch({ ownerScope: 'partner' })}
                data-testid="ai-agent-owner-partner"
              />
              {t('aiAgentsPage.editor.allOrgs')}{' '}
              <span className="text-muted-foreground">{t('aiAgentsPage.editor.allOrgsHint')}</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="ai-agent-owner"
                value="organization"
                checked={draft.ownerScope === 'organization'}
                onChange={() => patch({ ownerScope: 'organization' })}
                data-testid="ai-agent-owner-org"
              />
              {t('aiAgentsPage.editor.thisOrg')}
            </label>
          </fieldset>
        )}

        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('aiAgentsPage.fields.kind')}</span>
          <select
            className={inputCls}
            value={draft.kind}
            disabled={!isCreate}
            onChange={(e) => patch({ kind: e.target.value as AiAgentKind })}
            data-testid="ai-agent-kind"
          >
            {(isCreate ? availableKinds : AI_AGENT_KINDS).map((kind) => (
              <option key={kind} value={kind}>
                {t(/* i18n-dynamic */ `aiAgentsPage.kinds.${kind}`)}
              </option>
            ))}
          </select>
          {!isCreate && (
            <span className="block text-xs text-muted-foreground">
              {t('aiAgentsPage.fields.kindImmutable')}
            </span>
          )}
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('aiAgentsPage.fields.name')}</span>
          <input
            className={inputCls}
            maxLength={120}
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            data-testid="ai-agent-name"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('aiAgentsPage.fields.mode')}</span>
          <select
            className={inputCls}
            value={draft.mode}
            onChange={(e) => patch({ mode: e.target.value as AiAgentMode })}
            data-testid="ai-agent-mode"
          >
            <option value="off">{t('aiAgentsPage.modes.off')}</option>
            <option value="shadow">{t('aiAgentsPage.modes.shadow')}</option>
            {/* Not merely hidden: an operator needs to see that acting is a
                real, deliberate next step rather than a missing feature. The
                API refuses it with 422 mode_not_supported until wave 4. */}
            <option
              value="act"
              disabled={!(agent?.supportedModes ?? ['off', 'shadow']).includes('act')}
              data-testid="ai-agent-mode-act"
            >
              {t('aiAgentsPage.modes.act')}
            </option>
          </select>
        </label>

        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            data-testid="ai-agent-enabled"
          />
          <span>{t('aiAgentsPage.fields.enabled')}</span>
        </label>

        <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.scope')}
          </legend>
          <div className="flex flex-wrap gap-3">
            {SEVERITIES.map((severity) => (
              <label key={severity} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.severities.includes(severity)}
                  onChange={() => patch({ severities: toggle(draft.severities, severity) })}
                  data-testid={`ai-agent-severity-${severity}`}
                />
                {t(/* i18n-dynamic */ `aiAgentsPage.severities.${severity}`)}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.respectMaintenanceWindows}
              onChange={(e) => patch({ respectMaintenanceWindows: e.target.checked })}
              data-testid="ai-agent-respect-maintenance"
            />
            {t('aiAgentsPage.fields.respectMaintenanceWindows')}
          </label>
        </fieldset>

        <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.permissions')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.toolAllowlistHint')}</p>
          {listField('ai-agent-toolallowlist', t('aiAgentsPage.fields.toolAllowlist'), draft.toolAllowlist, (v) => patch({ toolAllowlist: v }), 4)}
          <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.protectedHint')}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {listField('ai-agent-services', t('aiAgentsPage.fields.protectedServices'), draft.services, (v) => patch({ services: v }), 2)}
            {listField('ai-agent-paths', t('aiAgentsPage.fields.protectedPaths'), draft.paths, (v) => patch({ paths: v }), 2)}
            {listField('ai-agent-registrykeys', t('aiAgentsPage.fields.protectedRegistryKeys'), draft.registryKeys, (v) => patch({ registryKeys: v }), 2)}
          </div>
        </fieldset>

        <fieldset className="grid gap-3 rounded-md border p-3 md:col-span-2 md:grid-cols-3">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.limits')}
          </legend>
          {numberField('ai-agent-limit-devices', t('aiAgentsPage.fields.maxDevicesPerRun'), draft.limits.maxDevicesPerRun, 1, 50, (v) => patch({ limits: { ...draft.limits, maxDevicesPerRun: v } }))}
          {numberField('ai-agent-limit-runs', t('aiAgentsPage.fields.maxRunsPerHour'), draft.limits.maxRunsPerHour, 1, 500, (v) => patch({ limits: { ...draft.limits, maxRunsPerHour: v } }))}
          {numberField('ai-agent-limit-budget', t('aiAgentsPage.fields.maxBudgetCentsPerDay'), draft.limits.maxBudgetCentsPerDay, 1, 100000, (v) => patch({ limits: { ...draft.limits, maxBudgetCentsPerDay: v } }))}
          {numberField('ai-agent-limit-wallclock', t('aiAgentsPage.fields.wallClockSeconds'), draft.limits.wallClockSeconds, 30, 1800, (v) => patch({ limits: { ...draft.limits, wallClockSeconds: v } }))}
          {numberField('ai-agent-limit-fleet', t('aiAgentsPage.fields.maxFleetPercentPerDay'), draft.limits.maxFleetPercentPerDay, 1, 100, (v) => patch({ limits: { ...draft.limits, maxFleetPercentPerDay: v } }))}
          {numberField('ai-agent-cooldown', t('aiAgentsPage.fields.cooldownSeconds'), draft.cooldownSeconds, 0, 86400, (v) => patch({ cooldownSeconds: v }))}
        </fieldset>

        <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.notifications')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.recipientRolesHint')}</p>
          {roles.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="ai-agent-roles-empty">
              {t('aiAgentsPage.fields.recipientRolesEmpty')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {roles.map((role) => (
                <label key={role.id} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.roleIds.includes(role.id)}
                    onChange={() => patch({ roleIds: toggle(draft.roleIds, role.id) })}
                    data-testid={`ai-agent-role-${role.id}`}
                  />
                  {role.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.instructions')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.instructionsHint')}</p>
          <textarea
            className={inputCls}
            rows={5}
            maxLength={INSTRUCTIONS_MAX}
            value={draft.instructions}
            onChange={(e) => patch({ instructions: e.target.value })}
            data-testid="ai-agent-instructions"
          />
          <p className="text-xs text-muted-foreground">
            {t('aiAgentsPage.fields.charactersLeft', { count: INSTRUCTIONS_MAX - draft.instructions.length })}
          </p>
        </fieldset>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
          data-testid="ai-agent-save"
        >
          {t('aiAgentsPage.actions.save')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-3 py-1.5 text-sm font-medium"
          data-testid="ai-agent-cancel"
        >
          {t('aiAgentsPage.actions.cancel')}
        </button>
        {agent && (
          <button
            type="button"
            onClick={() => void disable()}
            className="ml-auto rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive"
            data-testid="ai-agent-disable"
          >
            {confirmDisable ? t('aiAgentsPage.actions.confirmDisable') : t('aiAgentsPage.actions.disable')}
          </button>
        )}
      </div>
    </section>
  );
}
