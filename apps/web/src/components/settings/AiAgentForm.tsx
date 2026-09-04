import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
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
import { ConfirmDialog } from '../shared/ConfirmDialog';
import AiAgentSchedulesSection from './AiAgentSchedulesSection';
import AiAgentGraduationPanel from './AiAgentGraduationPanel';

// Severities come from @breeze/shared, the same constant the server validator
// uses. A local copy meant draftFrom() would silently DROP a stored severity
// the two lists disagreed on, and the next save would write the truncated list.
const SEVERITIES = ALERT_SEVERITIES;
type Severity = (typeof ALERT_SEVERITIES)[number];

export type { AiAgentDto };

interface RoleOption {
  id: string;
  name: string;
  /** `roles.scope` as GET /roles projects it. Optional on the type because an
   *  older API build omits it; such a role is grouped with the organization
   *  roles rather than dropped — a recipient must never disappear because a
   *  field it never had is missing. */
  scope?: 'partner' | 'organization';
}

function roleScope(role: RoleOption): 'partner' | 'organization' {
  return role.scope === 'partner' ? 'partner' : 'organization';
}

/** Rendered in this order; a group with no roles is skipped entirely. */
const ROLE_GROUPS = ['partner', 'organization'] as const;

/** GET /ai/agents/policy-decidable-keys — the read-only POLICY_DECIDABLE_TIER3
 *  registry (wave 5 Part B, #3827). `note` is the server's one-sentence
 *  description of what the operation actually does; it is rendered as the
 *  checkbox's description below. */
interface PolicyDecidableKeyOption {
  key: string;
  toolName: string;
  action: string | null;
  note: string;
}

/**
 * `manage_startup_items` -> "Manage startup items". Last-resort label for a
 * registry key this catalog has no translation for: the registry is
 * server-owned, so a key can ship in an API build before the web catalog
 * knows it, and the operator must still read words rather than an identifier.
 * Deliberately silent — a missing translation is a catalog gap to fix in the
 * next extraction pass, not a runtime fault worth a console line on every
 * render of this form.
 */
function sentenceCase(token: string): string {
  const words = token.replace(/[_:-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `manage_services:restart` -> `manage_services-restart`, so the key can be
 *  spliced into a DOM id (`aria-describedby` takes an id list, and a colon in
 *  an id is legal HTML but a syntax error in any selector that reads it). */
function idSafe(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '-');
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
  /**
   * Fires when this form starts or stops holding unsaved work of its own (an
   * edited schedule draft, which persists through a separate endpoint).
   *
   * Lifted to the parent because the DRAWER owns three of the four ways out —
   * Escape, the header X and the backdrop — and none of them could see a guard
   * that lived down here. The form used to defend the only exit it controlled,
   * its own Cancel button, while the reflexive ones discarded the draft
   * silently.
   */
  onDirtyChange?: (dirty: boolean) => void;
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

/**
 * Mode is the only field on this form that decides whether the agent may
 * touch a customer machine, so it is a three-card radiogroup rather than one
 * more `<select>` of the same weight as Name — and it is the FIRST decision,
 * above Kind and Name, because every field below it is read differently
 * depending on the answer.
 *
 * The order is the privilege ladder (`AI_AGENT_MODE_RANK`), which is also the
 * arrow-key order.
 */
const MODE_ORDER: readonly AiAgentMode[] = ['off', 'shadow', 'act'];

/**
 * Kinds whose runs can ever carry an alert severity — i.e. the only kinds for
 * which `triggers.alertSeverities` is read at all.
 *
 * `runService.ts` evaluates the severity list inside
 * `evaluateAgentTriggerFilters`, which runs ONLY when the admission input
 * carries an `alertContext`, and both producers of one
 * (`alertVerdictSubscriber.ts` and `automationRuntime.ts`) admit with
 * `kind: 'triage'`. A helpdesk agent is admitted from a ticket
 * (`ticketHelpdeskSubscriber.ts`, `ticketContext`), a patch agent from a
 * manual or scheduled trigger — neither carries a severity, so the list is
 * inert for both.
 *
 * Showing the control for those kinds asked the operator to make a choice
 * that could never take effect, and the client-side `.min(1)` check could
 * block a save over a field the server never reads for that kind. Hidden AND
 * omitted from the payload: on PATCH the one-level merge preserves whatever
 * is stored, and on create the server's `aiAgentTriggersSchema` supplies its
 * own `['critical', 'high']` default, so omission is never a `.min(1)` 400.
 */
const ALERT_SEVERITY_KINDS: ReadonlySet<AiAgentKind> = new Set<AiAgentKind>(['triage']);

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
    // CREATE defaults (the `??` fallbacks only ever apply when `agent` is
    // null): shadow, but SWITCHED OFF.
    //
    // `mode: 'shadow'` is what the first-run panel tells the operator to start
    // with, and the form used to contradict it by defaulting to `off`.
    // `enabled` was flipped to `true` in the same change and that went too far:
    // `enabled` is the live switch, not a mode preview. `syncManagedAutomation`
    // mirrors it onto the seeded automation the moment Save lands, and shadow
    // passes run admission — so creating a partner-wide triage agent started
    // real LLM runs across every org under the partner before anyone had looked
    // at the tool allowlist, the severities or the daily budget on the very
    // form that created it. Off is the only honest default for a switch whose
    // first flip spends money on machines the operator has not scoped yet; the
    // create-only hint beside the checkbox says so, so the unticked box reads
    // as a decision rather than an oversight.
    enabled: agent?.enabled ?? false,
    mode: agent?.mode ?? 'shadow',
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
  onDirtyChange,
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
  /** An unsaved schedule draft is open below (AiAgentSchedulesSection reports
   *  it). Schedules persist through their own endpoint, so the agent's Save
   *  would close the drawer and discard it silently. */
  const [scheduleDirty, setScheduleDirty] = useState(false);
  /** Cancel pressed while a schedule draft is unsaved. Cancel is the
   *  DELIBERATE exit, so it stays live and asks rather than going inert — the
   *  inert version taught operators to reach for the X instead, which is
   *  exactly the exit that used to discard the draft without a word. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Same latest-ref idiom AiAgentSchedulesSection uses for its own reporter: an
  // inline `onDirtyChange={...}` at the call site must not re-fire this on
  // every parent render, only on a change of DIRTINESS.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(scheduleDirty);
  }, [scheduleDirty]);
  // Unmounting is not "the operator resolved the draft" — but the draft goes
  // with it, and leaving the parent latched dirty would wedge the next agent's
  // drawer shut.
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);
  /**
   * Riley bug (#4187 UI critique): leaving act mode used to only HIDE the
   * supervised-keys fieldset, so Save still submitted keys the operator
   * could no longer see. The first fix over-corrected by CLEARING
   * `draft.supervisedActionKeys` on the way out of act, which meant an
   * act -> shadow -> act round trip silently lost a persisted grant list the
   * operator never touched (P2 review finding).
   *
   * The keys now stay in the draft for the whole life of the form —
   * `selectMode` below never touches them — and are omitted only from the
   * SAVE PAYLOAD while `draft.mode !== 'act'` (see `save()`'s `actAssets`).
   * This derived flag drives the announcement of that omission; it is not
   * separate state, so it can never drift from what Save will actually send.
   */
  const actKeysWillBeOmitted = draft.mode !== 'act' && draft.supervisedActionKeys.length > 0;

  const patch = (values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values }));

  const permissionsHeadingId = useId();
  const limitsBudgetId = useId();
  const limitsTimingId = useId();
  const toolSuggestInputId = useId();
  const toolSuggestListId = useId();
  const rolesGroupBaseId = useId();
  const severitiesGroupId = useId();
  const policyKeyNoteBaseId = useId();
  const nameInputId = useId();
  const nameErrorId = useId();
  const [toolSuggestion, setToolSuggestion] = useState('');
  /** Name has been left at least once. Until then an empty Name is "not
   *  filled in yet", not an error — a form that goes red before the operator
   *  has reached the field is scolding them for a field they were on their
   *  way to. */
  const [nameTouched, setNameTouched] = useState(false);
  const nameInvalid = nameTouched && draft.name.trim() === '';

  const usesAlertSeverities = ALERT_SEVERITY_KINDS.has(draft.kind);

  /** Registry tool -> translated group heading, falling back to the
   *  sentence-cased token (see `sentenceCase`). */
  const policyToolLabel = (toolName: string) =>
    t(/* i18n-dynamic */ `aiAgentsPage.policyKeys.tools.${toolName}`, {
      defaultValue: sentenceCase(toolName),
    });

  /** Registry entry -> translated operation label. Scoped by tool, because the
   *  bare action verb is ambiguous across the registry: "disable" appears
   *  against a startup item and a scheduled task, "enable" likewise, and a
   *  checkbox list of bare verbs cannot say which object it authorizes. A
   *  bare-tool entry (`action: null`) has no verb of its own, so it reads as
   *  the tool. */
  const policyActionLabel = (entry: PolicyDecidableKeyOption) =>
    entry.action === null
      ? policyToolLabel(entry.toolName)
      : t(/* i18n-dynamic */ `aiAgentsPage.policyKeys.actions.${entry.toolName}.${entry.action}`, {
        defaultValue: sentenceCase(entry.action),
      });

  /**
   * Autocomplete source for the tool allowlist. There is no tool-name
   * registry endpoint: `ACT_ELIGIBLE_TOOL_NAMES` is API-only and the
   * allowlist's own validator accepts any `TOOL_REF`-shaped string, so the
   * closest thing the client can source is the policy-decidable registry it
   * already fetched — offered as BOTH the bare tool name and the scoped
   * `tool:action` form, the two shapes `checkAgentGuardrails` admits.
   */
  const toolSuggestions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of policyKeys) {
      names.add(entry.toolName);
      names.add(entry.key);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [policyKeys]);

  const addSuggestedTool = () => {
    const value = toolSuggestion.trim();
    if (value === '') return;
    // `lines()` is the same de-duplicating reader the save body uses, so an
    // entry already present (however the operator typed it) never doubles.
    const next = [...new Set([...lines(draft.toolAllowlist), value])];
    patch({ toolAllowlist: next.join('\n') });
    setToolSuggestion('');
  };

  // ---- Mode: the privileged choice --------------------------------------
  const modeHeadingId = useId();
  const modeRefs = useRef<Partial<Record<AiAgentMode, HTMLButtonElement | null>>>({});
  // The CREATE path has no `agent` DTO yet, so the fallback must be the shared
  // constant and never `[]` — see the long note this file already carries on
  // the old `<option disabled>`; the reasoning survived the control change.
  const actSupported = (agent?.supportedModes ?? SUPPORTED_AGENT_MODES).includes('act');
  const modeUnavailable = (mode: AiAgentMode) => mode === 'act' && !actSupported;

  // Literal keys rather than a dynamic `t()` on the token: the closed
  // three-member union is worth spelling out so the keyUsage guard verifies
  // every label statically (same reason as AiAgentSchedulesSection's
  // `scheduleKindLabel`).
  const MODE_LABEL: Record<AiAgentMode, string> = {
    off: t('aiAgentsPage.modeChoice.off'),
    shadow: t('aiAgentsPage.modeChoice.shadow'),
    act: t('aiAgentsPage.modeChoice.act'),
  };
  // Literal keys, same reason as MODE_LABEL below: the closed two-member set
  // is spelled out so the keyUsage guard verifies both labels statically.
  const ROLE_GROUP_LABEL: Record<(typeof ROLE_GROUPS)[number], string> = {
    partner: t('aiAgentsPage.fields.recipientRolesPartner'),
    organization: t('aiAgentsPage.fields.recipientRolesOrganization'),
  };
  const MODE_CONSEQUENCE: Record<AiAgentMode, string> = {
    off: t('aiAgentsPage.modeChoice.offConsequence'),
    shadow: t('aiAgentsPage.modeChoice.shadowConsequence'),
    act: t('aiAgentsPage.modeChoice.actConsequence'),
  };

  const selectMode = (next: AiAgentMode) => {
    if (modeUnavailable(next) || next === draft.mode) return;
    if (next === 'act') {
      patch({ mode: next });
      return;
    }
    // Leaving act: only the acknowledgement belongs to act mode alone — a
    // genuine re-entry must ask again. `supervisedActionKeys` is NOT
    // cleared: it stays in the draft so a later return to act restores the
    // operator's selection, and `save()`'s payload is what keeps them out of
    // effect while the mode isn't act (see `actKeysWillBeOmitted` above).
    setActAck(false);
    patch({ mode: next });
  };

  /** Roving-tabindex arrow navigation, per the radiogroup pattern: the group
   *  holds one tab stop and the arrows move BOTH focus and selection.
   *
   *  The starting point is the option that HAS FOCUS (read off the event
   *  target's `data-mode`), never `draft.mode`. The two are normally the same —
   *  that is the roving contract — but they can diverge for one keystroke, and
   *  they did: the drawer's initial focus used to land on a `tabindex="-1"`
   *  card, so ArrowRight from Off (with Shadow selected) stepped from SHADOW
   *  and selected `act`, skipping the option the user was actually looking at.
   *  Deriving from focus makes the two impossible to disagree. */
  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const selectable = MODE_ORDER.filter((mode) => !modeUnavailable(mode));
    if (selectable.length === 0) return;
    const focused = (event.target as HTMLElement | null)?.dataset?.mode as AiAgentMode | undefined;
    // Falls back to the selected option when the key came from the group
    // itself rather than from one of its cards.
    const from = focused && selectable.includes(focused) ? focused : draft.mode;
    const current = Math.max(0, selectable.indexOf(from));
    let target: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = (current + 1) % selectable.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = (current - 1 + selectable.length) % selectable.length;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = selectable.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = selectable[target];
    if (!next) return;
    selectMode(next);
    modeRefs.current[next]?.focus();
  };

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
        // Defensive, not just a type assertion: `key`/`toolName` drive both
        // the DOM id splice (`idSafe`) and the translated-label fallback
        // (`sentenceCase`), and this registry is server-owned — a shape drift
        // must degrade to "skip the row", never crash the whole form.
        const rows = Array.isArray(body.data)
          ? body.data.filter(
              (row): row is PolicyDecidableKeyOption =>
                typeof row?.key === 'string' && typeof row?.toolName === 'string',
            )
          : [];
        if (!cancelled) setPolicyKeys(rows);
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
    // A schedule saves through its OWN request. Letting the agent Save run
    // while one is half-written closed the drawer and threw the draft away
    // without a word; the footer says why the button is inert.
    if (scheduleDirty) return;
    const problems: string[] = [];
    if (!draft.name.trim()) {
      problems.push(t('aiAgentsPage.issues.name'));
      // Also mark the field itself, so the summary at the top of the form and
      // the control it is about say the same thing.
      setNameTouched(true);
    }
    // `alertSeverities` is `.min(1)` server-side — an empty list is not
    // "all severities", it is a 400. Only asked of the kinds that can read it
    // (ALERT_SEVERITY_KINDS); for the others the field is hidden AND omitted
    // below, so there is nothing here to be empty.
    if (ALERT_SEVERITY_KINDS.has(draft.kind) && draft.severities.length === 0) {
      problems.push(t('aiAgentsPage.issues.severities'));
    }
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
        // Omitted, not sent as the draft value, for a kind whose runs can
        // never carry a severity (see ALERT_SEVERITY_KINDS): the form does not
        // show the control there, and sending a value the operator was never
        // offered would silently rewrite a stored list they cannot see. The
        // PATCH merge keeps what is stored; create takes the server default.
        ...(ALERT_SEVERITY_KINDS.has(draft.kind) ? { alertSeverities: draft.severities } : {}),
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
      //
      // P2 review fix: the draft KEEPS its supervisedActionKeys selection
      // across a mode change (see `selectMode`'s doc), but a non-act mode
      // can never use them — sent as [] rather than the draft's live value
      // so leaving act genuinely revokes them server-side, not just in the
      // UI, while still letting the operator's selection reappear if they
      // return to act before saving.
      actAssets: { supervisedActionKeys: draft.mode === 'act' ? draft.supervisedActionKeys : [] },
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
  }, [agent, draft, isCreate, orgScope.orgId, saving, scheduleDirty, onSaved, t]);

  const disable = useCallback(async () => {
    // `saving` guards this too: without it a double-click fires two DELETEs and
    // the second answers 404, so the operator sees a success toast AND
    // "Agent not found" for the kill switch they just used successfully.
    if (!agent || saving) return;
    // The dialog stays MOUNTED for the whole request, driven by `isLoading`,
    // and is closed in `finally`. Tearing it down here instead meant its
    // focus-restore fired while `saving` had already disabled the Disable
    // button it was restoring to — `.focus()` on a disabled element is a
    // no-op, so a keyboard user was dropped onto <body> in the middle of the
    // one action on this form that cannot be undone from here.
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
      setConfirmDisable(false);
    }
    if (disabled) onSaved();
  }, [agent, onSaved, saving, t]);

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

  // Roving-tabindex tab stop. Normally the checked option, but a stale row
  // can have `draft.mode` set to an option that is now disabled (an agent
  // saved while `act` was supported, whose partner later lost act
  // eligibility, still stores `mode: 'act'`) — falling back to the first
  // ENABLED option keeps the group reachable by Tab at all, rather than
  // leaving every radio at tabIndex -1.
  const tabStopMode = modeUnavailable(draft.mode)
    ? MODE_ORDER.find((mode) => !modeUnavailable(mode))
    : draft.mode;

  /** The mode radiogroup. Rendered as the first block of the form, before
   *  Kind and Name: it is the only choice here that can reach a device. */
  const modeChoice = (
    <div className="md:col-span-2" data-testid="ai-agent-mode-field">
      <h3 id={modeHeadingId} className="text-sm font-semibold">
        {t('aiAgentsPage.modeChoice.legend')}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={modeHeadingId}
        onKeyDown={onModeKeyDown}
        className="mt-2 grid gap-2 sm:grid-cols-3"
        data-testid="ai-agent-mode"
      >
        {MODE_ORDER.map((mode) => {
          const selected = draft.mode === mode;
          const unavailable = modeUnavailable(mode);
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={unavailable}
              tabIndex={mode === tabStopMode ? 0 : -1}
              ref={(node) => {
                modeRefs.current[mode] = node;
              }}
              onClick={() => selectMode(mode)}
              // Read by `onModeKeyDown` to find which card the keystroke came
              // from — the roving group's arrow keys must step from the FOCUSED
              // option, not from the stored one.
              data-mode={mode}
              // Act selected does NOT look like Off/Shadow selected. All three
              // shared one primary-blue ring, so the one card that authorizes
              // unattended changes on a customer machine read as no more
              // consequential than "do nothing" — the warning tone is the same
              // one the act warning panel and its icon already use.
              // `flex flex-col items-start` overrides the UA stylesheet's
              // vertical centring of a <button>'s content box. The three cards
              // stretch to a common height in the grid but carry consequence
              // lines of different lengths, so centred content put the three
              // option NAMES on three different baselines — the one line a
              // reader scans across before choosing.
              className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? mode === 'act'
                    ? 'border-warning-strong bg-warning/10 ring-1 ring-warning-strong'
                    : 'border-primary bg-primary/10 ring-1 ring-primary'
                  : 'bg-background hover:border-primary/50 hover:bg-muted/40'
              }`}
              data-testid={`ai-agent-mode-${mode}`}
            >
              {/* `w-full`: the card is now a flex COLUMN with `items-start`,
                  which shrinks its children to their content width — without
                  this the act card's `ml-auto` warning icon would sit against
                  the label instead of the card's right edge. */}
              <span className="flex w-full items-center gap-2">
                {/* Selection is encoded by SHAPE (a filled ring) as well as by
                    colour, so the choice survives a colourblind read. */}
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    selected
                      ? mode === 'act' ? 'border-warning-strong' : 'border-primary'
                      : 'border-muted-foreground/50'
                  }`}
                >
                  {selected && (
                    <span
                      className={`h-2 w-2 rounded-full ${mode === 'act' ? 'bg-warning-strong' : 'bg-primary'}`}
                    />
                  )}
                </span>
                <span className="text-sm font-medium">{MODE_LABEL[mode]}</span>
                {mode === 'act' && (
                  <AlertTriangle className="ml-auto h-4 w-4 shrink-0 text-warning-strong" aria-hidden="true" />
                )}
              </span>
              <span className="mt-1.5 block text-xs text-muted-foreground">
                {MODE_CONSEQUENCE[mode]}
              </span>
              {unavailable && (
                <span
                  className="mt-1.5 block text-xs text-muted-foreground"
                  data-testid="ai-agent-mode-act-unavailable"
                >
                  {t('aiAgentsPage.modeChoice.actUnavailable')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Attached to the choice, not floated below the rest of the fields:
          the warning and its acknowledgement are what the act card MEANS. */}
      {draft.mode === 'act' && (
        <div
          className="mt-2 space-y-2 rounded-lg border border-warning-strong/50 bg-warning/10 p-3 text-sm"
          data-testid="ai-agent-act-warning"
        >
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-strong" aria-hidden="true" />
            <span>{t('aiAgentsPage.actWarning.title')}</span>
          </p>
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

      {/* Mounted UNCONDITIONALLY — only the text toggles. An aria-live
          region (`role="status"`) only announces changes to content that was
          already present in the accessibility tree; mounting it on demand
          meant the FIRST thing it ever had to say was never announced. */}
      <p
        className="mt-2 text-xs text-muted-foreground"
        role="status"
        data-testid="ai-agent-act-keys-cleared"
      >
        {actKeysWillBeOmitted ? t('aiAgentsPage.fields.actKeysCleared') : ''}
      </p>
    </div>
  );

  /** The registry checkboxes, grouped by tool with translated labels — shared
   *  between the plain (org, act-only) rendering and the partner-wide
   *  `<details>` wrapper below, so the two never drift out of sync. */
  const policyKeysBody = policyKeysFailed ? (
    <p className="text-sm text-destructive" data-testid="ai-agent-policy-keys-failed">
      {t('aiAgentsPage.fields.supervisedActionKeysFailed')}
    </p>
  ) : policyKeys.length === 0 ? (
    <p className="text-sm text-muted-foreground" data-testid="ai-agent-policy-keys-empty">
      {t('aiAgentsPage.fields.supervisedActionKeysEmpty')}
    </p>
  ) : (
    <div className="space-y-3">
      {[...groupByTool(policyKeys).entries()].map(([toolName, entries]) => (
        <div key={toolName}>
          <p className="text-xs font-semibold">{policyToolLabel(toolName)}</p>
          <div className="space-y-1.5">
            {entries.map((entry) => {
              // `idSafe`: a colon in `manage_services:restart` is a legal DOM
              // id character but a syntax error in a CSS/query selector, so
              // the registry key can't be spliced into the id raw.
              const noteId = `${policyKeyNoteBaseId}-${idSafe(entry.key)}`;
              return (
                <label key={entry.key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={draft.supervisedActionKeys.includes(entry.key)}
                    onChange={() =>
                      patch({ supervisedActionKeys: toggle(draft.supervisedActionKeys, entry.key) })}
                    aria-describedby={noteId}
                    data-testid={`ai-agent-supervised-key-${entry.key}`}
                  />
                  <span>
                    <span className="block">{policyActionLabel(entry)}</span>
                    {/* The registry's own one-sentence description of what the
                        operation actually does — wired as the checkbox's
                        accessible description, not just adjacent text, so a
                        screen reader announces it as part of the control. */}
                    <span id={noteId} className="block text-xs text-muted-foreground">
                      {entry.note}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  /* Wave 5 Part B (#3827). Gated the same way as the act-warning block above
   * (draft.mode === 'act' only) for ORG rows — the "act acknowledgement
   * pattern": this is additional unattended authority an operator is opting
   * into only once they are already looking at the act-mode warning, never
   * offered for shadow/off.
   * PARTNER rows are the exception (#4583): per P2-5 (#4192) a partner row's
   * keys are a CEILING on org grants, not authority the partner row exercises
   * itself — ticking a key here authorizes nothing on its own regardless of
   * the partner row's own mode, so gating the editor (and its ceiling hint)
   * behind the partner row's act mode hid the warning precisely when it
   * mattered: while editing a Shadow-mode baseline.
   *
   * A partner row's registry is collapsed behind a native `<details>` while
   * the row is NOT acting — placed BELOW Permissions rather than above it,
   * since these checkboxes refine the tool allowlist Permissions already
   * sets, not precede it. The summary counts the selection rather than
   * repeating the full ceiling explanation (still given underneath, once
   * opened), so a shadow-mode baseline reads as one scannable line instead of
   * a checkbox list that authorizes nothing on its own from this row. The
   * moment the row enters act mode the list is unwrapped entirely (not just
   * opened) — that is the one mode where THIS row's own dispatch can be
   * gated by these keys, so it earns the same plain treatment an org row
   * always gets; the ceiling caveat still prints beneath it as a fact that
   * survives the mode, not as something act mode makes disappear. An org row
   * has no ceiling caveat to begin with and is only ever shown in act mode,
   * so it renders the list directly with no wrapper at all. */
  const collapsedForCeiling = draft.ownerScope === 'partner' && draft.mode !== 'act';
  const ceilingNote = draft.ownerScope === 'partner' && (
    <p className="text-xs text-muted-foreground" data-testid="ai-agent-supervised-keys-ceiling-hint">
      {t('aiAgentsPage.graduation.ceilingHint')}
    </p>
  );
  const policyDecideFieldset = (draft.mode === 'act' || draft.ownerScope === 'partner') && (
    <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-policy-decide">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('aiAgentsPage.sections.policyDecide')}
      </legend>
      <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.supervisedActionKeysHint')}</p>
      {collapsedForCeiling ? (
        <details data-testid="ai-agent-policy-keys-details">
          <summary className="cursor-pointer text-xs font-medium">
            {t('aiAgentsPage.fields.supervisedActionKeysCeilingSummary', {
              count: draft.supervisedActionKeys.length,
            })}
          </summary>
          <div className="mt-1 space-y-2">
            {ceilingNote}
            {policyKeysBody}
          </div>
        </details>
      ) : (
        <>
          {ceilingNote}
          {policyKeysBody}
        </>
      )}
    </fieldset>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-agent-editor">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {issues.length > 0 && (
          <ul
            className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive"
            data-testid="ai-agent-issues"
          >
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {modeChoice}

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

          {/* The only required free-text field on the form, and it used to
              look exactly like the optional ones — the first sign it was
              required was a Save that refused. Marked with the repo's
              required convention (the destructive-toned asterisk from
              ApiKeyForm.tsx) and validated on blur, so the operator learns it
              at the field rather than at the button.
              A <div> with `htmlFor` rather than a wrapping <label>: the error
              paragraph is a sibling of the input, and nesting it inside the
              label would fold the error text into the input's own accessible
              name instead of its description. */}
          <div className="space-y-1 text-sm">
            <label className="block font-medium" htmlFor={nameInputId}>
              {t('aiAgentsPage.fields.name')}<span className="text-destructive">*</span>
            </label>
            <input
              id={nameInputId}
              className={`${inputCls} ${nameInvalid ? 'border-destructive' : ''}`}
              maxLength={120}
              required
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? nameErrorId : undefined}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              onBlur={() => setNameTouched(true)}
              data-testid="ai-agent-name"
            />
            {nameInvalid && (
              <p id={nameErrorId} className="text-xs text-destructive" data-testid="ai-agent-name-error">
                {t('aiAgentsPage.issues.name')}
              </p>
            )}
          </div>

          {/* `enabled` and `mode` are two independent gates, and BOTH have to
              pass: runService's admission skips `agent_disabled` before it ever
              looks at the mode, and skips `mode_off` right after. Representable
              nonsense (`enabled: true, mode: 'off'`) is therefore real, and the
              helper below is the only place the form says so. */}
          <div className="space-y-1 self-end text-sm md:col-span-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
                data-testid="ai-agent-enabled"
              />
              <span className="font-medium">{t('aiAgentsPage.fields.enabled')}</span>
            </label>
            <p className="pl-6 text-xs text-muted-foreground" data-testid="ai-agent-enabled-hint">
              {t('aiAgentsPage.fields.enabledHint')}
            </p>
            {/* Create only: an unticked box on a brand-new form reads as
                something the operator forgot, not as the product's deliberate
                choice. Naming it turns the box into the last, explicit step. */}
            {isCreate && (
              <p className="pl-6 text-xs text-muted-foreground" data-testid="ai-agent-enabled-create-hint">
                {t('aiAgentsPage.fields.enabledCreateHint')}
              </p>
            )}
          </div>

          {/* Graduation evidence (P2-5, #4192). Edit-only, for the same reason
              the schedules section is: the evidence ledger is keyed to a
              persisted agent that does not exist until the first save. NOT gated
              on `draft.mode === 'act'` — evidence an agent already earned is a
              fact about the past, so toggling an unsaved draft back to shadow
              must not make it disappear. The panel is read-only-useful with
              `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` off; see its module doc.
              `agent.kind` (stored), not `draft.kind`, since kind is create-only.
              An org-owned agent always reads its OWN org's evidence; a partner
              baseline follows the org switcher, and falls through to the
              partner-wide grouping when it is on "all organizations". */}
          {!isCreate && (
            <AiAgentGraduationPanel
              orgId={agent.orgId ?? orgScope.orgId}
              kind={agent.kind}
              isPartnerScope={isPartnerScope}
            />
          )}

          <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('aiAgentsPage.sections.scope')}
            </legend>
            {/* Hidden — never just left unread — for a kind whose runs can
                never carry a severity (see ALERT_SEVERITY_KINDS's docstring):
                runService only evaluates `triggers.alertSeverities` when the
                admission input carries an `alertContext`, which only a
                triage-kind run ever does. Offering the control for helpdesk
                or patch asked the operator to make a choice that could never
                take effect. */}
            {usesAlertSeverities && (
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
            )}
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

          {/* Permissions carries the widest blast radius of the remaining
              sections, so it gets a real heading rather than one more 12px
              uppercase legend of the same weight as "Limits". A <section> and
              not a <fieldset>: <legend>'s content model is phrasing content, so
              an <h3> cannot live inside one. */}
          <section
            className="space-y-2 rounded-md border p-3 md:col-span-2"
            aria-labelledby={permissionsHeadingId}
            data-testid="ai-agent-permissions"
          >
            <div>
              <h3 id={permissionsHeadingId} className="text-sm font-semibold">
                {t('aiAgentsPage.sections.permissions')}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('aiAgentsPage.sections.permissionsDescription')}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.toolAllowlistHint')}</p>
            {listField('ai-agent-toolallowlist', t('aiAgentsPage.fields.toolAllowlist'), draft.toolAllowlist, (v) => patch({ toolAllowlist: v }), 4)}
            {/* No tool-name registry endpoint exists (the API's
                ACT_ELIGIBLE_TOOL_NAMES / the MCP tool set are server-only), so
                this is autocomplete over the ONE name source the client already
                holds — the policy-decidable registry this form fetches for the
                act-mode section. Deliberately labelled as a partial list rather
                than presented as the closed set of tools. */}
            {toolSuggestions.length > 0 && (
              <div className="space-y-1">
                <label className="block text-xs font-medium" htmlFor={toolSuggestInputId}>
                  {t('aiAgentsPage.fields.toolSuggestLabel')}
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id={toolSuggestInputId}
                    className={`${inputCls} font-mono sm:w-64`}
                    list={toolSuggestListId}
                    value={toolSuggestion}
                    onChange={(e) => setToolSuggestion(e.target.value)}
                    data-testid="ai-agent-toolallowlist-suggest"
                  />
                  <datalist id={toolSuggestListId} data-testid="ai-agent-toolallowlist-suggestions">
                    {toolSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    onClick={addSuggestedTool}
                    disabled={toolSuggestion.trim() === ''}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                    data-testid="ai-agent-toolallowlist-add"
                  >
                    {t('aiAgentsPage.fields.toolSuggestAdd')}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.toolSuggestHint')}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.protectedHint')}</p>
            <div className="grid gap-3 md:grid-cols-3">
              {listField('ai-agent-services', t('aiAgentsPage.fields.protectedServices'), draft.services, (v) => patch({ services: v }), 2)}
              {listField('ai-agent-paths', t('aiAgentsPage.fields.protectedPaths'), draft.paths, (v) => patch({ paths: v }), 2)}
              {listField('ai-agent-registrykeys', t('aiAgentsPage.fields.protectedRegistryKeys'), draft.registryKeys, (v) => patch({ registryKeys: v }), 2)}
            </div>
          </section>

          {policyDecideFieldset}

          {/* Six unlabelled number inputs in one 3-column grid read as one
              undifferentiated wall. Split into the two questions they actually
              answer — how much may it spend and reach, and how long may it take
              — with every control and every test id unchanged. */}
          <fieldset className="space-y-3 rounded-md border p-3 md:col-span-2">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('aiAgentsPage.sections.limits')}
            </legend>
            <div role="group" aria-labelledby={limitsBudgetId} className="space-y-1.5">
              <p id={limitsBudgetId} className="text-xs font-medium">
                {t('aiAgentsPage.sections.limitsBudget')}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {numberField('ai-agent-limit-devices', t('aiAgentsPage.fields.maxDevicesPerRun'), draft.limits.maxDevicesPerRun, 1, 50, (v) => patch({ limits: { ...draft.limits, maxDevicesPerRun: v } }))}
                {numberField('ai-agent-limit-runs', t('aiAgentsPage.fields.maxRunsPerHour'), draft.limits.maxRunsPerHour, 1, 500, (v) => patch({ limits: { ...draft.limits, maxRunsPerHour: v } }))}
                {numberField('ai-agent-limit-budget', t('aiAgentsPage.fields.maxBudgetCentsPerDay'), draft.limits.maxBudgetCentsPerDay, 1, 100000, (v) => patch({ limits: { ...draft.limits, maxBudgetCentsPerDay: v } }))}
                {numberField('ai-agent-limit-fleet', t('aiAgentsPage.fields.maxFleetPercentPerDay'), draft.limits.maxFleetPercentPerDay, 1, 100, (v) => patch({ limits: { ...draft.limits, maxFleetPercentPerDay: v } }))}
              </div>
            </div>
            <div role="group" aria-labelledby={limitsTimingId} className="space-y-1.5">
              <p id={limitsTimingId} className="text-xs font-medium">
                {t('aiAgentsPage.sections.limitsTiming')}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {numberField('ai-agent-limit-wallclock', t('aiAgentsPage.fields.wallClockSeconds'), draft.limits.wallClockSeconds, 30, 1800, (v) => patch({ limits: { ...draft.limits, wallClockSeconds: v } }))}
                {numberField('ai-agent-cooldown', t('aiAgentsPage.fields.cooldownSeconds'), draft.cooldownSeconds, 0, 86400, (v) => patch({ cooldownSeconds: v }))}
              </div>
            </div>
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
              // Nine flat checkboxes with partner and organization roles
              // interleaved read as one undifferentiated list, and the two
              // answer different questions: who at the MSP hears about this,
              // and who at the customer does. Grouped, not filtered — every
              // control the flat list carried is still here.
              <div className="space-y-3">
                {ROLE_GROUPS.map((scope) => {
                  const group = roles.filter((role) => roleScope(role) === scope);
                  if (group.length === 0) return null;
                  return (
                    <div key={scope} role="group" aria-labelledby={`${rolesGroupBaseId}-${scope}`}>
                      <p id={`${rolesGroupBaseId}-${scope}`} className="text-xs font-medium">
                        {ROLE_GROUP_LABEL[scope]}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-3" data-testid={`ai-agent-roles-${scope}`}>
                        {group.map((role) => (
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
                    </div>
                  );
                })}
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
              onDirtyChange={setScheduleDirty}
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
      </div>

      {/* Outside the scroll area: in the drawer the form now opens in, Save
          must stay reachable without scrolling past the schedules section and
          two graduation tables. */}
      <div className="border-t bg-card px-5 py-4">
        {/* Beside the buttons it explains, not buried in the scroll area
            above: while it is showing, Save and Cancel are inert, and the
            reason has to be visible at the point the operator reaches for
            them. */}
        {scheduleDirty && (
          <p
            className="mb-3 rounded-md border border-warning-strong/50 bg-warning/10 px-3 py-2 text-sm"
            role="status"
            data-testid="ai-agent-schedule-dirty"
          >
            {t('aiAgentsPage.issues.unsavedSchedule')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={
              saving
              || scheduleDirty
              || (isCreate && availableKinds.length === 0)
              || (enteringActMode && !actAck)
            }
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="ai-agent-save"
          >
            {t('aiAgentsPage.actions.save')}
          </button>
          <button
            type="button"
            onClick={() => (scheduleDirty ? setConfirmDiscard(true) : onClose())}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            data-testid="ai-agent-cancel"
          >
            {t('aiAgentsPage.actions.cancel')}
          </button>
          {agent && (
            <button
              type="button"
              onClick={() => setConfirmDisable(true)}
              disabled={saving || scheduleDirty}
              className="ml-auto rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive disabled:opacity-60"
              data-testid="ai-agent-disable"
            >
              {t('aiAgentsPage.actions.disable')}
            </button>
          )}
        </div>
      </div>

      {/* The kill switch was a label swap — "Disable" became "Confirm
          disable", stayed armed indefinitely, and never said what disabling
          actually does. Same ConfirmDialog ceremony as every other guarded
          action in the app, and the message names both halves: what stops,
          and what survives.
          `variant="warning"`, not the destructive default: disabling an agent
          is reversible (re-enabling is one checkbox away, and the retained
          text below says what survives), so the destructive red/octagon
          treatment overstated the stakes of a switch, not a deletion. */}
      {agent && (
        <ConfirmDialog
          open={confirmDisable}
          onClose={() => setConfirmDisable(false)}
          onConfirm={() => void disable()}
          variant="warning"
          title={t('aiAgentsPage.disableDialog.title', { name: agent.name })}
          message={t('aiAgentsPage.disableDialog.message')}
          confirmLabel={t('aiAgentsPage.actions.disable')}
          isLoading={saving}
          confirmTestId="ai-agent-disable-confirm"
        >
          <p className="text-sm text-muted-foreground" data-testid="ai-agent-disable-retained">
            {t('aiAgentsPage.disableDialog.retained')}
          </p>
        </ConfirmDialog>
      )}

      {/* Warning, not destructive: nothing persisted is being removed — the
          operator is throwing away a draft that never left the browser. */}
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        variant="warning"
        title={t('aiAgentsPage.unsavedSchedule.discardTitle')}
        message={t('aiAgentsPage.unsavedSchedule.discardMessage')}
        confirmLabel={t('aiAgentsPage.unsavedSchedule.discardConfirm')}
        confirmTestId="ai-agent-discard-schedule-confirm"
      />
    </div>
  );
}
