import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  ALERT_SEVERITIES,
  SUPPORTED_AGENT_MODES,
  type AiAgentDto,
  type AiAgentKind,
  type AiAgentMode,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { useOrgScope } from '@/hooks/useOrgScope';
import { useDefaultOwnerScope, type OwnerScope } from '@/hooks/useDefaultOwnerScope';
import AiAgentSchedulesSection from './AiAgentSchedulesSection';

// Severities come from @breeze/shared, the same constant the server validator
// uses. A local copy meant draftFrom() would silently DROP a stored severity
// the two lists disagreed on, and the next save would write the truncated list.
const SEVERITIES = ALERT_SEVERITIES;
type Severity = (typeof ALERT_SEVERITIES)[number];

export type { AiAgentDto };

interface RoleOption {
  id: string;
  name: string;
}

/** GET /ai/agents/policy-decidable-keys — the read-only POLICY_DECIDABLE_TIER3
 *  registry (wave 5 Part B, #3827). `note` is fetched but not currently
 *  rendered; kept on the type for parity with the wire shape. */
interface PolicyDecidableKeyOption {
  key: string;
  toolName: string;
  action: string | null;
  note: string;
}

/** Groups registry entries by `toolName`, preserving the server's ordering
 *  within each group (policyDecidable.ts orders entries deliberately — see
 *  its module doc). */
function groupByTool(entries: PolicyDecidableKeyOption[]): Map<string, PolicyDecidableKeyOption[]> {
  const groups = new Map<string, PolicyDecidableKeyOption[]>();
  for (const entry of entries) {
    const list = groups.get(entry.toolName);
    if (list) list.push(entry);
    else groups.set(entry.toolName, [entry]);
  }
  return groups;
}

interface Props {
  /** null = create a new agent. */
  agent: AiAgentDto | null;
  /**
   * Every agent visible to this session. The taken-kind set must be derived
   * against the OWNER the draft is targeting, not flattened across both axes —
   * uniqueness is (partner_id, kind) and (org_id, kind) independently.
   */
  agents: AiAgentDto[];
  /** Show the partner-wide vs org-owned selector (create-only, partner-scope users). */
  showOwnerScope: boolean;
  defaultOwnerScope: OwnerScope;
  onClose: () => void;
  onSaved: () => void;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/**
 * Machine token -> operator-facing sentence. The API answers these with a
 * `code`, and runAction's `friendly` hook is keyed on it; without this the
 * toast shows the token verbatim.
 */
const AGENT_ERROR_COPY: Record<string, ((t: (key: string) => string) => string) | undefined> = {
  agent_kind_exists: (t) => t('aiAgentsPage.errors.kindExists'),
  mode_not_supported: (t) => t('aiAgentsPage.errors.modeNotSupported'),
  // The server's 422 (Task 6, #3826) is the authoritative gate — the
  // structured `missing[]` it carries is rendered as issues below, this is
  // just the toast fallback so the raw machine token never reaches the user.
  act_prerequisites_not_met: (t) => t('aiAgentsPage.errors.actPrerequisitesNotMet'),
  // Wave 5 Part B (#3827): the server's 422 (agentService.ts's
  // InvalidSupervisedActionKeysError) carries a structured `rejected[]` —
  // this is just the toast fallback; the per-key detail is rendered as
  // issues below via ACT_PREREQUISITE_COPY's sibling handling in save()'s
  // catch block.
  invalid_supervised_action_keys: (t) => t('aiAgentsPage.errors.invalidSupervisedActionKeys'),
};

/**
 * `missing[]` entries from the server's `act_prerequisites_not_met` 422
 * (Task 6, #3826 — `ActPrerequisitesNotMetError`). Mapped to translated,
 * actionable copy so the operator sees what to fix rather than a machine
 * token.
 */
const ACT_PREREQUISITE_COPY: Record<string, (t: (key: string) => string) => string> = {
  recipient: (t) => t('aiAgentsPage.errors.actMissingRecipient'),
  act_eligible_tool: (t) => t('aiAgentsPage.errors.actMissingTool'),
};

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';
const INSTRUCTIONS_MAX = 2000;

/** Newline-separated textarea → trimmed, de-duplicated list. */
function lines(value: string): string[] {
  return [...new Set(value.split('\n').map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * Kinds still creatable for one ownership axis. The DB enforces
 * `(partner_id, kind) WHERE org_id IS NULL` and `(org_id, kind)` as two
 * independent partial uniques, both `WHERE disabled_at IS NULL`, so a kind is
 * only taken for the owner that actually holds it.
 */
function freeKinds(
  agents: AiAgentDto[],
  ownerScope: OwnerScope,
  orgId: string | null,
): AiAgentKind[] {
  const taken = new Set(
    agents
      .filter((row) =>
        ownerScope === 'partner'
          ? row.ownerScope === 'partner'
          : row.ownerScope === 'organization' && row.orgId === orgId,
      )
      .map((row) => row.kind),
  );
  return AI_AGENT_KINDS.filter((kind) => !taken.has(kind));
}

function firstFreeKind(
  agents: AiAgentDto[],
  ownerScope: OwnerScope,
  orgId: string | null,
): AiAgentKind | undefined {
  return freeKinds(agents, ownerScope, orgId)[0];
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
  /** Wave 5 Part B (#3827). Operator's per-agent opt-in to unattended
   *  policy-decided authorization — see actAssets in save() below. */
  supervisedActionKeys: string[];
  /** P2-4 (#4191). Org-row-only opt-in that lifts the forced-shadow behavior
   *  for ticket-triggered runs — same "reads ONLY the org's own override"
   *  merge semantics as `anomalyEnabled` (never itself surfaced on this
   *  form). See `AiAgentTriggers.ticketAutonomousWrites`'s docstring. */
  ticketAutonomousWrites: boolean;
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
    supervisedActionKeys: agent?.actAssets?.supervisedActionKeys ?? [],
    ticketAutonomousWrites: agent?.triggers?.ticketAutonomousWrites ?? false,
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
  agents,
  showOwnerScope,
  defaultOwnerScope,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation('settings');
  const orgScope = useOrgScope();
  // Read from the single source of the partner-scope rule rather than reusing
  // `showOwnerScope`: that prop means "offer the create-only owner selector",
  // which happens to be the same boolean today but is not the same QUESTION —
  // the schedules section asks whether this session may write partner-wide
  // policy at all (canManagePartnerWidePolicies' client-side counterpart).
  const { isPartnerScope } = useDefaultOwnerScope();
  const isCreate = agent === null;

  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(agent, {
      ownerScope: defaultOwnerScope,
      kind: firstFreeKind(agents, defaultOwnerScope, orgScope.orgId) ?? AI_AGENT_KINDS[0],
    }),
  );

  // Captured once at mount (the parent keys this form by agent id, so a new
  // edit target remounts rather than reusing state — see
  // "does not carry a stale draft" below). The acknowledgement gate only
  // applies to a genuine transition INTO act mode, not to every subsequent
  // edit of an agent that is already acting.
  const [initialMode] = useState<AiAgentMode>(agent?.mode ?? 'off');
  const [actAck, setActAck] = useState(false);
  const enteringActMode = draft.mode === 'act' && initialMode !== 'act';

  // Recomputed on every owner-scope flip. Flattening this across both axes is
  // what previously hid `triage` from the PARTNER-WIDE create form as soon as
  // any single org owned a triage agent — and with no partner baseline,
  // resolveEffectiveAgent returns null, so triage was dead for every org.
  const availableKinds = useMemo(
    () => freeKinds(agents, draft.ownerScope, orgScope.orgId),
    [agents, draft.ownerScope, orgScope.orgId],
  );
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [rolesFailed, setRolesFailed] = useState(false);
  const [policyKeys, setPolicyKeys] = useState<PolicyDecidableKeyOption[]>([]);
  const [policyKeysFailed, setPolicyKeysFailed] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const patch = (values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values }));

  // Recipients are role IDs, never role names: `roles` is a tenant-scoped table
  // with partner-defined names, so the picker has to show the real rows.
  //
  // A failure here must NOT render as "no roles exist". This page is gated on
  // organizations:read but GET /roles is gated on users:read, so a technician
  // holding the former and not the latter gets a 403 — and telling them their
  // tenant has no roles would turn an authorization error into a configuration
  // decision they never made, saving an agent that notifies nobody.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/roles');
        if (!response.ok) throw new Error(`GET /roles ${response.status}`);
        const body = (await response.json()) as { data?: RoleOption[] };
        if (!cancelled) setRoles(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        console.error('[AiAgentForm] could not load roles', err);
        if (!cancelled) setRolesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The POLICY_DECIDABLE_TIER3 registry (wave 5 Part B, #3827) — a static,
  // read-only list, so no dependency on mode/agent; fetched once per mount
  // exactly like roles above, and rendered only inside the act-mode section
  // below. A failure must say so rather than rendering an empty registry,
  // same "authorization/outage vs. genuinely empty" distinction the roles
  // fetch above draws (this route needs only ai_agents:read, which this page
  // is already gated on, so a 403 here is unexpected — but the failure state
  // still must not lie and claim the registry is empty).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/ai/agents/policy-decidable-keys');
        if (!response.ok) throw new Error(`GET /ai/agents/policy-decidable-keys ${response.status}`);
        const body = (await response.json()) as { data?: PolicyDecidableKeyOption[] };
        if (!cancelled) setPolicyKeys(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        console.error('[AiAgentForm] could not load policy-decidable keys', err);
        if (!cancelled) setPolicyKeysFailed(true);
      }
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

    // On PATCH the server merges each nested object one level onto the stored
    // jsonb (updatePolicyColumns), so the narrowing fields this form does not
    // expose — triggers.siteIds / deviceGroupIds / deviceTags,
    // protectedResources.deviceTags, recipients.userIds — survive a save rather
    // than being erased, which would silently WIDEN the agent's blast radius.
    // One level is enough only because every sub-value is a scalar or an array
    // today; a nested object inside one of these would need a real deep merge.
    // On create there is nothing to merge — these are written wholesale.
    const policy = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      mode: draft.mode,
      triggers: {
        alertSeverities: draft.severities,
        respectMaintenanceWindows: draft.respectMaintenanceWindows,
        ticketAutonomousWrites: draft.ticketAutonomousWrites,
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
      // Wave 5 Part B (#3827): scriptIds is not this form's field to send —
      // omitting it here relies on the SAME one-level PATCH merge the
      // top-of-function comment already documents (updatePolicyColumns
      // merges { ...stored.actAssets, ...input.actAssets }), so an existing
      // scriptIds value survives a save that only ever touches
      // supervisedActionKeys. On create, the server's createAiAgentSchema
      // defaults the omitted scriptIds to [].
      actAssets: { supervisedActionKeys: draft.supervisedActionKeys },
    };

    let saved = false;
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
        // Without this the operator sees the raw machine token the API puts in
        // `error` — literally "agent_kind_exists: triage".
        friendly: (code) => AGENT_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED
      });
      saved = true;
    } catch (err) {
      // Project rule: 401 is handled by the redirect, other ActionErrors were
      // already toasted by runAction, and anything else must still be loud.
      handleActionError(err, t('aiAgentsPage.toasts.saveFailed'));
      // The client-side ack checkbox is only a UX nudge — the server's 422
      // prerequisites (Task 6, #3826) are authoritative, e.g. the agent's
      // recipients or act-eligible tools changed between load and save.
      // Surface exactly what it named as unmet, not just the generic toast.
      if (err instanceof ActionError && err.code === 'act_prerequisites_not_met') {
        const body = err.body as { missing?: unknown } | undefined;
        const missing = Array.isArray(body?.missing)
          ? body.missing.filter((entry): entry is string => typeof entry === 'string')
          : [];
        setIssues(
          missing.map((entry) => ACT_PREREQUISITE_COPY[entry]?.(t) ?? entry),
        );
      }
      // Wave 5 Part B (#3827): the server's 422 (InvalidSupervisedActionKeysError)
      // carries a structured `rejected[]` naming exactly which keys failed and
      // why — same "actionable, not a bare toast" pattern as the prerequisites
      // branch above.
      if (err instanceof ActionError && err.code === 'invalid_supervised_action_keys') {
        const body = err.body as { rejected?: unknown } | undefined;
        const rejected = Array.isArray(body?.rejected)
          ? body.rejected.filter(
              (entry): entry is { key: string; reason: string } =>
                typeof entry === 'object'
                && entry !== null
                && typeof (entry as { key?: unknown }).key === 'string'
                && typeof (entry as { reason?: unknown }).reason === 'string',
            )
          : [];
        setIssues(
          rejected.map((entry) =>
            t('aiAgentsPage.errors.supervisedKeyRejected', { key: entry.key, reason: entry.reason })),
        );
      }
    } finally {
      setSaving(false);
    }
    // Outside the try: a render error thrown by the parent's reload must not
    // be reported to the operator as "could not save the agent".
    if (saved) onSaved();
  }, [agent, draft, isCreate, orgScope.orgId, saving, onSaved, t]);

  const disable = useCallback(async () => {
    // `saving` guards this too: without it a double-click fires two DELETEs and
    // the second answers 404, so the operator sees a success toast AND
    // "Agent not found" for the kill switch they just used successfully.
    if (!agent || saving) return;
    if (!confirmDisable) {
      setConfirmDisable(true);
      return;
    }
    setConfirmDisable(false);
    setSaving(true);
    let disabled = false;
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/agents/${agent.id}`, { method: 'DELETE' }),
        successMessage: t('aiAgentsPage.toasts.disabled'),
        errorFallback: t('aiAgentsPage.toasts.disableFailed'),
        friendly: (code) => AGENT_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED
      });
      disabled = true;
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.toasts.disableFailed'));
    } finally {
      setSaving(false);
    }
    if (disabled) onSaved();
  }, [agent, confirmDisable, onSaved, saving, t]);

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
        onChange={(e) => {
          // Clearing a number input yields '' -> NaN, which JSON.stringify
          // emits as null and the server rejects with a bare 400.
          const next = Number(e.target.value);
          onChange(Number.isFinite(next) ? next : min);
        }}
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
                onChange={() => patch({ ownerScope: 'partner', kind: firstFreeKind(agents, 'partner', orgScope.orgId) ?? draft.kind })}
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
                onChange={() => patch({ ownerScope: 'organization', kind: firstFreeKind(agents, 'organization', orgScope.orgId) ?? draft.kind })}
                data-testid="ai-agent-owner-org"
              />
              {t('aiAgentsPage.editor.thisOrg')}
            </label>
          </fieldset>
        )}

        {isCreate && availableKinds.length === 0 && (
          <p className="text-sm text-muted-foreground md:col-span-2" data-testid="ai-agent-kinds-exhausted">
            {t('aiAgentsPage.issues.allKindsTaken')}
          </p>
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
                real, deliberate next step rather than a missing feature.
                Gated on the API's supportedModes (Task 6, #3826) — the
                server's create/update prerequisites (recipient +
                act-eligible surface) are the authoritative gate; the warning
                banner and acknowledgement below are this form's contribution
                on top of that. Review fix (#3826 final-review): the CREATE
                path has no `agent` DTO yet (it is null until the first save),
                so the fallback must be the shared `SUPPORTED_AGENT_MODES`
                constant — not `[]` — or the option is permanently disabled on
                every create form regardless of what the API actually
                supports, which is exactly the drift the constant's own
                docstring exists to prevent. */}
            <option
              value="act"
              disabled={!(agent?.supportedModes ?? SUPPORTED_AGENT_MODES).includes('act')}
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

        {draft.mode === 'act' && (
          <div
            className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm md:col-span-2"
            data-testid="ai-agent-act-warning"
          >
            <p className="font-medium">{t('aiAgentsPage.actWarning.title')}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t('aiAgentsPage.actWarning.unattended')}</li>
              <li>{t('aiAgentsPage.actWarning.verification')}</li>
              <li>{t('aiAgentsPage.actWarning.noRollback')}</li>
              <li>{t('aiAgentsPage.actWarning.singleDevice')}</li>
              <li>{t('aiAgentsPage.actWarning.actionCap')}</li>
            </ul>
            {enteringActMode && (
              <label className="flex items-start gap-2 pt-1 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={actAck}
                  onChange={(e) => setActAck(e.target.checked)}
                  data-testid="ai-agent-act-ack"
                />
                <span>{t('aiAgentsPage.actWarning.ack')}</span>
              </label>
            )}
          </div>
        )}

        {/* Wave 5 Part B (#3827). Gated the same way as the act-warning block
            above (draft.mode === 'act' only) — the "act acknowledgement
            pattern": this is additional unattended authority an operator is
            opting into only once they are already looking at the act-mode
            warning, never offered for shadow/off. */}
        {draft.mode === 'act' && (
          <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-policy-decide">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('aiAgentsPage.sections.policyDecide')}
            </legend>
            <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.supervisedActionKeysHint')}</p>
            {policyKeysFailed ? (
              <p className="text-sm text-destructive" data-testid="ai-agent-policy-keys-failed">
                {t('aiAgentsPage.fields.supervisedActionKeysFailed')}
              </p>
            ) : policyKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="ai-agent-policy-keys-empty">
                {t('aiAgentsPage.fields.supervisedActionKeysEmpty')}
              </p>
            ) : (
              <div className="space-y-2">
                {[...groupByTool(policyKeys).entries()].map(([toolName, entries]) => (
                  <div key={toolName}>
                    <p className="text-xs font-semibold">{toolName}</p>
                    <div className="flex flex-wrap gap-3">
                      {entries.map((entry) => (
                        <label key={entry.key} className="flex items-center gap-1 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.supervisedActionKeys.includes(entry.key)}
                            onChange={() =>
                              patch({ supervisedActionKeys: toggle(draft.supervisedActionKeys, entry.key) })}
                            data-testid={`ai-agent-supervised-key-${entry.key}`}
                          />
                          {entry.action ?? entry.toolName}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </fieldset>
        )}

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

          {/* P2-4 (#4191) review fix — ticket-triggered runs are admitted
              with `kind: 'helpdesk'` (ticketHelpdeskSubscriber.ts's
              `admitTriageRun`: `createAndEnqueueAgentRun({ kind: 'helpdesk',
              triggerKind: 'ticket', profile: 'triage', ... })`), and
              runService.ts's `resolveEffectiveAgentSystem(orgId, kind)`
              resolves the effective policy off THAT `kind` field — never
              `triage`, which is a different agent kind entirely (the
              scheduled-sweeps gate a few lines below IS genuinely
              triage-only; do not copy this gate from that one again).
              Disabled — never hidden — on a partner-wide row: the merge
              reads ONLY the org's own override (effectivePolicy.ts), so a
              partner baseline value can never take effect; hiding it
              outright would look like the field vanished rather than
              explain why it cannot be set here. */}
          {draft.kind === 'helpdesk' && (
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.ticketAutonomousWrites}
                  disabled={draft.ownerScope !== 'organization'}
                  onChange={(e) => patch({ ticketAutonomousWrites: e.target.checked })}
                  data-testid="ai-agent-ticket-autonomous-writes"
                />
                {t('aiAgentsPage.fields.ticketAutonomousWrites')}
              </label>
              <p className="pl-6 text-xs text-muted-foreground">
                {t('aiAgentsPage.fields.ticketAutonomousWritesHint')}
              </p>
            </div>
          )}
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
          {rolesFailed ? (
            <p className="text-sm text-destructive" data-testid="ai-agent-roles-failed">
              {t('aiAgentsPage.fields.recipientRolesFailed')}
            </p>
          ) : roles.length === 0 ? (
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

        {/* Scheduled sweeps (P2-2, #4189). Edit-only, because a schedule row
            references a persisted agent id that does not exist until the first
            save; triage-only, because the API refuses every other kind
            (`agent_kind_not_triage`). Gated on the STORED kind, not the draft:
            kind is create-only, so the two cannot diverge on this form. */}
        {!isCreate && agent.kind === 'triage' && (
          <AiAgentSchedulesSection
            agentId={agent.id}
            agentOwnerScope={agent.ownerScope}
            isPartnerScope={isPartnerScope}
            orgId={orgScope.orgId}
          />
        )}

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
          disabled={saving || (isCreate && availableKinds.length === 0) || (enteringActMode && !actAck)}
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
