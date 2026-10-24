/**
 * `identity_offboarding` — offboard one person across Google Workspace and
 * Microsoft 365 (Operator Recipe Library spec §1, §6.2–§6.7; W06 R1a).
 *
 * PURE. This file is data plus pure functions, scanned by `purity.test.ts`:
 * it may import only `zod`, `@breeze/shared`, `../operationKey` and siblings.
 * Discovery, readiness, admission and dispatch all live OUTSIDE `recipes/`.
 *
 * THE ORDERING CONTRACT (spec §6.3). Within each provider block the order is
 *
 *   auto-reply → forwarding → mailbox delegate → group memberships
 *   → licences → mobile → sessions → disable/suspend
 *
 * and disable/suspend is LAST. Mailbox effects must run while the account is
 * still active, because suspension blocks Gmail impersonation; disable/suspend
 * is last so that a task stopped at ANY point leaves an account that is more
 * restricted than before, never one that is disabled with mail unrouted.
 * Provider blocks run in `EFFECT_PROVIDER_ORDER` = google, m365 — a fixed
 * order, not a preference, so the digest of a plan is reproducible.
 * `identityOffboarding.ordering.test.ts` asserts this over every prefix.
 *
 * WHAT THE PLAN NEVER CONTAINS:
 *  - `google_offboard_user`: one tool call with seven effects has one
 *    operation key, so a replay re-runs all seven and "3/7 OK" has no
 *    per-effect result row.
 *  - `google_wipe_mobile_device`: a FULL FACTORY RESET (`admin_remote_wipe`).
 *    The selective account wipe is `google_account_wipe_mobile_device`.
 *  - M365 forwarding, mailbox delegation and shared-mailbox conversion: no
 *    Exchange Online executor exists (spec §7.3). Always human work.
 *  - `m365_remove_license` when `keepMailbox` is set: removing the Exchange
 *    licence starts the mailbox's deletion clock, and the shared-mailbox
 *    conversion that must precede it has no API. "Not planned" is the only
 *    safe reading; a manual item replaces it.
 *  - Any Breeze device effect: no lock / log-off tool exists. Each device the
 *    technician selected becomes a manual item (Amendment A.3, D2).
 *
 * FACTS. `buildPlan(input, facts)` reads the planning snapshot `discover`
 * froze (R1a-0): `facts.google` / `facts.m365` (identity facts),
 * `facts.targets.contactTargetId` (the contact's `ai_operator_task_targets.id`,
 * which is what `PlannedEffect.targetId` carries), and `facts.degradedTools`
 * (the tools readiness said this org cannot dispatch, frozen with the facts so
 * a later readiness change cannot alter a sealed plan). The two required
 * fields THROW when absent, so `planEffectStep` fails closed instead of
 * planning against a guessed target. Everything else is read defensively:
 * facts arrive from a jsonb column.
 */
import {
  identityIntakeOutputSchema,
  identityOffboardingInputSchema,
  identityReviewOutputSchema,
  type IdentityOffboardingInput,
} from '@breeze/shared';
import { buildTaskOperationKey } from '../operationKey';
import type {
  CapabilityRequirement,
  DiscoveryFacts,
  EffectProvider,
  PlannedEffect,
  RecipeBounds,
  RecipeDefinition,
} from './types';

export const IDENTITY_OFFBOARDING_WORKFLOW_KEY = 'identity_offboarding' as const;
export const IDENTITY_OFFBOARDING_WORKFLOW_VERSION = 1 as const;
/** Bump whenever `taskContextIdentity.ts`'s rendering changes (see serviceRecovery.ts). */
export const IDENTITY_OFFBOARDING_PROMPT_VERSION = 'identity_offboarding/v1' as const;

export const IDENTITY_OFFBOARDING_STEP_KEYS = Object.freeze([
  'intake', 'confirm_identity', 'discover', 'review', 'effects',
  'manual_work', 'verify_outcome', 'document',
] as const);
export type IdentityOffboardingStepKey = (typeof IDENTITY_OFFBOARDING_STEP_KEYS)[number];

/**
 * FIXED, not a preference. `effect_set_digest` is a hash over the ordered
 * list, so a provider order that varied by org would make two identical plans
 * hash differently and every approval card unreproducible.
 */
export const EFFECT_PROVIDER_ORDER = Object.freeze(['google', 'm365'] as const);

/**
 * The CLOSED effect catalog. `buildPlan` may emit nothing else, readiness maps
 * every entry to a capability, and the agent-allowlist capability names
 * exactly this list — so widening it in one place without the others is a
 * test failure, not a silent privilege gain.
 */
export const IDENTITY_OFFBOARDING_EFFECT_TOOLS = Object.freeze([
  // Google, in safety order.
  'google_set_vacation',
  'google_set_forwarding',
  'google_add_mail_delegate',
  'google_remove_from_group',
  'google_remove_license',
  'google_account_wipe_mobile_device',
  'google_signout',
  'google_suspend_user',
  // M365, in safety order. No forwarding and no delegate: spec §7.3.
  'm365_set_auto_reply',
  'm365_remove_from_group',
  'm365_remove_license',
  'm365_retire_intune_device',
  'm365_revoke_sessions',
  'm365_disable_user',
  // No Breeze device effect: no lock / log-off tool exists. Selected devices
  // are manual items.
] as const);

/**
 * Effects with no observable end state, each mapped to the effect whose
 * verified success SUBSUMES it (spec §6.6, D-R1-11).
 *
 * `google_signout`: the Directory API exposes no session-validity field and
 * `lastLoginTime` is not one. A verified suspend on the SAME account makes
 * live sessions moot. `m365_revoke_sessions` is NOT here: M1 gives it a real
 * criterion (`signInSessionsValidFromDateTime >= effectRequestedAt`).
 */
export const IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS: Readonly<Record<string, string>> = Object.freeze({
  google_signout: 'google_suspend_user',
});

/**
 * Spec §6.7. Stricter than the agent policy, never looser.
 *
 * 14 days, not the Operator's 72 h default and not `service_recovery`'s 24 h:
 * an approval can land on Monday, a cutoff can be scheduled for Friday at 5pm,
 * and a technician can be off site for a week before the laptop comes back.
 */
export const IDENTITY_OFFBOARDING_BOUNDS: RecipeBounds = Object.freeze({
  maxReasoningRuns: 6,
  maxMutationAttempts: 2,
  freshnessSeconds: 900,
  observeWakeAfterMs: 60_000,
  verificationWakeAfterMs: 120_000,
  unknownEffectHorizonMs: 60 * 60 * 1000,
  deadlineMs: 14 * 24 * 60 * 60 * 1000,
});

const HELPDESK_ALLOWLIST_CAPABILITY = 'agent.helpdesk.tool_allowlist';

/**
 * Fifteen capabilities: provider connections, one per-effect gate per Google
 * tool family, one per M365 Graph role group, the three Exchange product gaps,
 * and the helpdesk allowlist umbrella.
 *
 * The `google.tool.*` entries are `agent_tool` rather than `permission_grant`
 * because Google's authority is domain-wide delegation granted once at
 * connection time — there is no per-effect grant to observe. `m365.graph.*`
 * are `permission_grant` because M1's `m365RoleReadiness` gives a real
 * per-role answer.
 */
export const IDENTITY_OFFBOARDING_CAPABILITIES: readonly CapabilityRequirement[] = Object.freeze([
  { key: 'google.workspace.connection', kind: 'provider_connection', provider: 'google',
    detail: 'Connect Google Workspace for this organization.' },
  { key: 'google.tool.mail_settings', kind: 'agent_tool', provider: 'google',
    detail: 'Google mail settings (auto-reply, forwarding, delegation).',
    toolNames: ['google_set_vacation', 'google_set_forwarding', 'google_add_mail_delegate'] },
  { key: 'google.tool.group_membership_write', kind: 'agent_tool', provider: 'google',
    detail: 'Removing Google group memberships.', toolNames: ['google_remove_from_group'] },
  { key: 'google.tool.license_write', kind: 'agent_tool', provider: 'google',
    detail: 'Removing Google Workspace licences.', toolNames: ['google_remove_license'] },
  { key: 'google.tool.mobile_account_wipe', kind: 'agent_tool', provider: 'google',
    detail: 'Removing the work account from enrolled mobile devices.',
    toolNames: ['google_account_wipe_mobile_device'] },
  { key: 'google.tool.session_revoke', kind: 'agent_tool', provider: 'google',
    detail: 'Signing the person out of Google sessions.', toolNames: ['google_signout'] },
  { key: 'google.tool.suspend', kind: 'agent_tool', provider: 'google',
    detail: 'Suspending the Google account.', toolNames: ['google_suspend_user'] },

  { key: 'm365.connection', kind: 'provider_connection', provider: 'm365',
    detail: 'Connect Microsoft 365 for this organization.' },
  { key: 'm365.graph.auto_reply', kind: 'permission_grant', provider: 'm365',
    detail: 'Microsoft 365 mailbox auto-reply (MailboxSettings.ReadWrite). Re-consent Microsoft 365.',
    toolNames: ['m365_set_auto_reply'] },
  { key: 'm365.graph.group_membership_write', kind: 'permission_grant', provider: 'm365',
    detail: 'Removing Microsoft 365 group memberships (GroupMember.ReadWrite.All). Re-consent Microsoft 365.',
    toolNames: ['m365_remove_from_group'] },
  { key: 'm365.graph.license_write', kind: 'permission_grant', provider: 'm365',
    detail: 'Removing Microsoft 365 licences (User.ReadWrite.All).', toolNames: ['m365_remove_license'] },
  { key: 'm365.graph.intune_retire', kind: 'permission_grant', provider: 'm365',
    detail: 'Retiring Intune-managed devices (DeviceManagementManagedDevices.PrivilegedOperations.All). Re-consent Microsoft 365.',
    toolNames: ['m365_retire_intune_device'] },
  { key: 'm365.graph.session_revoke', kind: 'permission_grant', provider: 'm365',
    detail: 'Revoking Microsoft 365 sign-in sessions (User.ReadWrite.All).', toolNames: ['m365_revoke_sessions'] },
  { key: 'm365.graph.user_disable', kind: 'permission_grant', provider: 'm365',
    detail: 'Disabling the Microsoft 365 account (User.ReadWrite.All).', toolNames: ['m365_disable_user'] },

  // Spec §7.3: declared profile, no executor, no code path. These are the ONLY
  // THREE `always_manual` capabilities: nothing a tenant or a technician can do
  // makes them satisfied, so they degrade to human work and do NOT hold the
  // recipe at `setup_required` (D-R1-12). They are still declared, so the
  // library card can say "3 steps will be done by hand".
  //
  // WHEN M2 (the Exchange Online executor) SHIPS: flip these three to
  // `availability: 'tenant_fixable'` and nothing else changes.
  { key: 'm365.exchange.forwarding', kind: 'tool_source', provider: 'm365',
    availability: 'always_manual',
    detail: 'Microsoft 365 mailbox forwarding needs Exchange Online PowerShell, which Breeze does not automate yet. This step is done by hand.' },
  { key: 'm365.exchange.mailbox_delegate', kind: 'tool_source', provider: 'm365',
    availability: 'always_manual',
    detail: 'Microsoft 365 mailbox delegation needs Exchange Online PowerShell, which Breeze does not automate yet. This step is done by hand.' },
  { key: 'm365.exchange.shared_mailbox_conversion', kind: 'tool_source', provider: 'm365',
    availability: 'always_manual',
    detail: 'Converting a mailbox to shared needs Exchange Online PowerShell, which Breeze does not automate yet. This step is done by hand.' },

  { key: HELPDESK_ALLOWLIST_CAPABILITY, kind: 'agent_tool', provider: null,
    detail: 'The helpdesk agent must be allowed to use the identity tools this recipe dispatches.',
    toolNames: [...IDENTITY_OFFBOARDING_EFFECT_TOOLS] },
] satisfies CapabilityRequirement[]);

/** Effect tool → the capability key that gates it. Derived, never hand-maintained. */
export const CAPABILITY_FOR_TOOL: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    IDENTITY_OFFBOARDING_CAPABILITIES
      .filter((c) => c.key !== HELPDESK_ALLOWLIST_CAPABILITY)
      .flatMap((c) => (c.toolNames ?? []).map((t) => [t, c.key] as const)),
  ),
);

export interface IdentityManualWorkItem {
  /** Stable, e.g. 'collect_hardware'. The dedupe key and the order key. */
  key: string;
  /** ≤ 500 chars — the checklist item's label. */
  label: string;
  /** Generated instructions. */
  detail: string;
  origin: 'always' | 'capability' | 'flag' | 'discovery';
  /** The capability whose absence generated it, when origin === 'capability'. */
  capabilityKey: string | null;
}

/** `ticket_checklist_items.label` is varchar(500). */
const MAX_LABEL_CHARS = 500;
const MAX_DETAIL_CHARS = 2000;

// ---------------------------------------------------------------------------
// Fact accessors — narrow, defensive readers over an open jsonb record.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function arr(v: unknown): Rec[] {
  return Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : [];
}

interface GroupFact { id: string; email: string | null; name: string; ownership: string; dynamic: boolean; roleAssignable: boolean }
interface ProviderFacts {
  present: boolean;
  externalId: string | null;
  email: string | null;
  groups: GroupFact[];
  licenses: Rec[];
  devices: Rec[];
}

function providerFacts(facts: DiscoveryFacts, provider: 'google' | 'm365'): ProviderFacts {
  const p = rec(facts[provider]);
  const groups = arr(p?.groups).flatMap((g): GroupFact[] => {
    const id = str(g.id);
    if (!id) return [];
    return [{
      id,
      email: str(g.email),
      name: str(g.name) ?? id,
      ownership: str(g.ownership) ?? 'unknown',
      dynamic: g.dynamic === true,
      roleAssignable: g.roleAssignable === true,
    }];
  });
  return {
    present: p?.present === true,
    externalId: str(p?.externalId),
    email: provider === 'google' ? str(p?.primaryEmail) : str(p?.userPrincipalName),
    groups,
    licenses: arr(p?.licenses),
    devices: arr(provider === 'google' ? p?.mobileDevices : p?.intuneDevices),
  };
}

/** The contact's target ROW id (E4: `PlannedEffect.targetId` is a target row id). Throws when absent. */
function contactTargetIdOf(facts: DiscoveryFacts): string {
  const id = str(rec(facts.targets)?.contactTargetId);
  if (!id) throw new Error('identity_offboarding: planning facts carry no targets.contactTargetId');
  return id;
}

/** The degraded-tool set frozen in the snapshot. Throws when absent: never assume "nothing degraded". */
function degradedToolsOf(facts: DiscoveryFacts): ReadonlySet<string> {
  const v = facts.degradedTools;
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) {
    throw new Error('identity_offboarding: planning facts carry no degradedTools list');
  }
  return new Set(v as string[]);
}

/** How the person is named in generated text. Frozen label first, then an address. */
function labelFor(facts: DiscoveryFacts): string {
  return str(rec(facts.targets)?.contactLabel)
    ?? providerFacts(facts, 'google').email
    ?? providerFacts(facts, 'm365').email
    ?? 'the departing person';
}

/** Where the person's mail goes: an explicit address, else the inheritor's frozen address. */
function mailDestination(input: IdentityOffboardingInput, facts: DiscoveryFacts): string | null {
  return input.forwardTo ?? str(rec(facts.inheritor)?.email);
}

function deviceLabel(facts: DiscoveryFacts, deviceId: string): string {
  return str(rec(rec(facts.targets)?.deviceLabels)?.[deviceId]) ?? deviceId;
}

function defaultAutoReply(label: string): string {
  return `${label} is no longer with the organization. Your message has not been forwarded automatically; `
    + 'please contact the organization directly for assistance.';
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type Push = (provider: EffectProvider, toolName: string, accountExternalId: string | null, args: Rec) => void;

function pushGoogleBlock(push: Push, input: IdentityOffboardingInput, facts: DiscoveryFacts, label: string): void {
  const g = providerFacts(facts, 'google');
  // An account we cannot address by its immutable id and its address is not
  // planned against at all; the verify step and the manual list cover it.
  if (!g.present || !g.externalId || !g.email) return;
  const userEmail = g.email;
  const id = g.externalId;
  const fx = input.effects;
  const dest = mailDestination(input, facts);

  if (fx.autoReply) {
    push('google', 'google_set_vacation', id, {
      userEmail, enable: true, subject: 'Out of office',
      message: input.autoReplyMessage ?? defaultAutoReply(label),
    });
  }
  if (fx.forwarding && dest) push('google', 'google_set_forwarding', id, { userEmail, forwardTo: dest, keepCopy: false });
  if (fx.mailDelegate && dest) push('google', 'google_add_mail_delegate', id, { userEmail, delegateEmail: dest });
  if (fx.removeGroups) {
    for (const group of g.groups) {
      if (!group.email) continue; // the tool addresses a group by email; none known → manual item
      push('google', 'google_remove_from_group', id, { userEmail, groupEmail: group.email });
    }
  }
  if (fx.removeLicenses) {
    for (const l of g.licenses) {
      const productId = str(l.productId);
      const skuId = str(l.skuId);
      if (!productId || !skuId) continue;
      push('google', 'google_remove_license', id, { userEmail, productId, skuId });
    }
  }
  if (fx.wipeMobile && g.devices.length > 0) push('google', 'google_account_wipe_mobile_device', id, { userEmail });
  if (fx.revokeSessions) push('google', 'google_signout', id, { userEmail });
  if (fx.disableAccount) push('google', 'google_suspend_user', id, { userEmail });
}

function pushM365Block(push: Push, input: IdentityOffboardingInput, facts: DiscoveryFacts, label: string): void {
  const m = providerFacts(facts, 'm365');
  if (!m.present || !m.externalId) return;
  // The Entra object id — NEVER the UPN (spec §5.2), so a rename mid-task
  // cannot retarget an effect.
  const userIdentifier = m.externalId;
  const fx = input.effects;

  if (fx.autoReply) {
    const message = input.autoReplyMessage ?? defaultAutoReply(label);
    push('m365', 'm365_set_auto_reply', userIdentifier, {
      userIdentifier, status: 'alwaysEnabled',
      internalReplyMessage: message, externalReplyMessage: message, externalAudience: 'all',
    });
  }
  // No forwarding and no delegate: no Exchange executor (spec §7.3).
  if (fx.removeGroups) {
    for (const group of m.groups) {
      // M1's executor refuses these (`unsupported_group_type`); never plan an
      // effect that can only fail. Each becomes a manual item instead.
      if (group.dynamic || group.roleAssignable) continue;
      push('m365', 'm365_remove_from_group', userIdentifier, { groupId: group.id, userIdentifier });
    }
  }
  if (fx.removeLicenses && !input.keepMailbox) {
    const skuIds = m.licenses.map((l) => str(l.skuId)).filter((s): s is string => s !== null);
    // ONE effect: M1's schema takes an array and assignLicense is one Graph call.
    if (skuIds.length > 0) push('m365', 'm365_remove_license', userIdentifier, { userIdentifier, skuIds });
  }
  if (fx.wipeMobile) {
    for (const d of m.devices) {
      const managedDeviceId = str(d.id);
      if (managedDeviceId) push('m365', 'm365_retire_intune_device', userIdentifier, { managedDeviceId });
    }
  }
  if (fx.revokeSessions) push('m365', 'm365_revoke_sessions', userIdentifier, { userIdentifier });
  if (fx.disableAccount) push('m365', 'm365_disable_user', userIdentifier, { userIdentifier });
}

/** The plan before the frozen degraded set is applied. Internal: never sealed. */
function buildUndegradedPlan(input: IdentityOffboardingInput, facts: DiscoveryFacts): PlannedEffect[] {
  const out: PlannedEffect[] = [];
  const targetId = contactTargetIdOf(facts);
  const label = labelFor(facts);
  const reason = `Offboarding ${label} (Breeze Operator task).`;
  const push: Push = (provider, toolName, accountExternalId, args) => {
    out.push({
      ordinal: out.length,
      toolName,
      provider,
      targetId, // ai_operator_task_targets.id (E4), never the contact id
      accountExternalId,
      canonicalArguments: Object.freeze({ ...args, reason }),
    });
  };
  for (const provider of EFFECT_PROVIDER_ORDER) {
    if (provider === 'google') pushGoogleBlock(push, input, facts, label);
    else pushM365Block(push, input, facts, label);
  }
  return out;
}

/**
 * Pure. Same input + same facts → the same ordered list.
 *
 * The degraded set is frozen in the snapshot: filter, then renumber densely so
 * the ordinals the approver sees are contiguous. A degraded effect is never
 * proposed, so an approver is never asked to authorize something that can
 * only fail; it becomes a manual item instead.
 */
export function buildIdentityOffboardingPlan(
  input: IdentityOffboardingInput,
  facts: DiscoveryFacts,
): PlannedEffect[] {
  const degraded = degradedToolsOf(facts);
  const undegraded = buildUndegradedPlan(input, facts);
  const held = heldLockouts(undegraded, degraded);
  return undegraded
    // Only the LOCKOUT is held; the provider's other effects still run.
    .filter((e) => !degraded.has(e.toolName)
      && !(e.provider !== 'breeze' && e.toolName === LOCKOUT_TOOL[e.provider] && held.has(e.provider)))
    .map((e, i) => ({ ...e, ordinal: i }));
}

/** Effects that change where a person's mail goes or how it is answered. */
export const MAIL_ROUTING_TOOLS: Readonly<Record<'google' | 'm365', readonly string[]>> = Object.freeze({
  google: Object.freeze(['google_set_vacation', 'google_set_forwarding', 'google_add_mail_delegate']),
  m365: Object.freeze(['m365_set_auto_reply']),
});
/** The effect after which the account can no longer sign in. */
export const LOCKOUT_TOOL: Readonly<Record<'google' | 'm365', string>> = Object.freeze({
  google: 'google_suspend_user',
  m365: 'm365_disable_user',
});

/**
 * The ordering contract, applied to degradation (spec §6.3): a provider's
 * account is never locked out while a mail effect the plan ASKED for is not
 * going to run. When a requested mail-routing tool is degraded, the lockout is
 * held back too and becomes a manual item to do after the mail steps — the
 * alternative, suspending with the mail step left for a person to do later,
 * is exactly the "disabled with mail unrouted" state the order exists to
 * prevent. Provider → the degraded mail tools that hold it.
 */
function heldLockouts(
  undegraded: readonly PlannedEffect[],
  degraded: ReadonlySet<string>,
): Map<'google' | 'm365', string[]> {
  const out = new Map<'google' | 'm365', string[]>();
  for (const provider of EFFECT_PROVIDER_ORDER) {
    const ofProvider = undegraded.filter((e) => e.provider === provider);
    const lockout = ofProvider.some((e) => e.toolName === LOCKOUT_TOOL[provider] && !degraded.has(e.toolName));
    if (!lockout) continue;
    const missingMail = [...new Set(ofProvider
      .filter((e) => MAIL_ROUTING_TOOLS[provider].includes(e.toolName) && degraded.has(e.toolName))
      .map((e) => e.toolName))];
    if (missingMail.length > 0) out.set(provider, missingMail);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manual work (spec §6.5)
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const CAPABILITY_BY_KEY: ReadonlyMap<string, CapabilityRequirement> = new Map(
  IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => [c.key, c]),
);

/**
 * Every manual item this task generates, in a STABLE order with unique keys.
 *
 * Order: always-on items, capability degradations, Exchange items,
 * discovery-derived items, review flags. `manualWork.ts` creates them all up
 * front and binds step rows by index, so index i must mean the same item on
 * every wake — which is why the order is structural and the map dedupes.
 *
 * A capability item is generated only for an effect the plan WOULD have
 * contained: a tool in the frozen degraded set, or one whose capability
 * `readiness` reports unsatisfied. That keeps the manual list and the plan's
 * exclusions in lockstep, and stops an M365-only org being told to do Google
 * work by hand.
 */
export function buildIdentityOffboardingManualWork(
  input: IdentityOffboardingInput,
  facts: DiscoveryFacts,
  readiness: Readonly<Record<string, boolean>>,
  reviewFlags: readonly { code: string; subject: string; detail: string }[],
): IdentityManualWorkItem[] {
  const items = new Map<string, IdentityManualWorkItem>();
  const add = (item: IdentityManualWorkItem): void => {
    if (items.has(item.key)) return;
    items.set(item.key, { ...item, label: clip(item.label, MAX_LABEL_CHARS), detail: clip(item.detail, MAX_DETAIL_CHARS) });
  };
  const label = labelFor(facts);
  const google = providerFacts(facts, 'google');
  const m365 = providerFacts(facts, 'm365');
  const fx = input.effects;

  // 1. Always.
  add({
    key: 'collect_hardware', origin: 'always', capabilityKey: null,
    label: `Collect ${label}'s company hardware`,
    detail: 'Collect every company laptop, phone, key and badge assigned to this person, and record what was returned.',
  });
  for (const deviceId of input.deviceIds) {
    const host = deviceLabel(facts, deviceId);
    add({
      key: `device_signout_${deviceId}`, origin: 'always', capabilityKey: null,
      label: `Sign ${label} out of ${host} and collect it`,
      detail: `Breeze has no device lock or log-off action yet. On ${host}, sign ${label} out (or lock the `
        + 'device), make sure no session remains, and collect the device.',
    });
  }
  add({
    key: 'transfer_file_ownership', origin: 'always', capabilityKey: null,
    label: `Transfer ownership of ${label}'s files`,
    detail: 'Move or transfer ownership of this person\'s files (Google Drive, OneDrive, shared folders) to '
      + 'whoever inherits their work, before the account is deleted.',
  });
  add({
    key: 'update_documentation', origin: 'always', capabilityKey: null,
    label: `Update documentation and shared logins for ${label}`,
    detail: 'Remove this person from contact lists, on-call rotas and runbooks, and change any shared '
      + 'login they knew.',
  });

  // 2. Capability degradations — only for effects the plan would have contained.
  const degraded = degradedToolsOf(facts);
  const callerHeld = new Set(Array.isArray(facts.callerVerificationTools)
    ? (facts.callerVerificationTools as unknown[]).filter((t): t is string => typeof t === 'string') : []);
  const degradedCapabilities = new Set<string>();
  for (const effect of buildUndegradedPlan(input, facts)) {
    const capabilityKey = CAPABILITY_FOR_TOOL[effect.toolName];
    if (!capabilityKey) continue;
    // Held back ONLY by caller verification, with the capability itself
    // satisfied: a specific item below says why, not a "missing grant" one.
    if (callerHeld.has(effect.toolName) && readiness[capabilityKey] === true) continue;
    if (degraded.has(effect.toolName) || readiness[capabilityKey] !== true) degradedCapabilities.add(capabilityKey);
  }
  for (const capabilityKey of IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => c.key)) {
    if (!degradedCapabilities.has(capabilityKey)) continue;
    const cap = CAPABILITY_BY_KEY.get(capabilityKey)!;
    const provider = cap.provider === 'm365' ? 'Microsoft 365' : 'Google Workspace';
    add({
      key: `capability:${capabilityKey}`, origin: 'capability', capabilityKey,
      label: `Do by hand in ${provider}: ${cap.detail}`,
      detail: `Breeze cannot do this for ${label} in this organization: ${cap.detail} `
        + `Do it in the ${provider} admin console for ${label}, then tick this item.`,
    });
  }

  // Caller verification (a policy choice): the account step is done by hand.
  if (m365.present && fx.disableAccount && callerHeld.has('m365_disable_user')) {
    add({
      key: 'caller_verification:m365_disable_user', origin: 'capability', capabilityKey: 'm365.graph.user_disable',
      label: `Disable ${label}'s Microsoft 365 account by hand`,
      detail: 'This organization\'s caller-verification policy requires a verified caller before a Microsoft 365 '
        + 'account is disabled, and an offboarding has no caller to verify, so Breeze did not plan this step. '
        + 'Once the mail and access steps above are done, block sign-in for this person in the Microsoft 365 '
        + 'admin centre (Users → Active users → Block sign-in).',
    });
  }

  // The lockout held back by a degraded mail step (see `heldLockouts`).
  for (const [provider, mailTools] of heldLockouts(buildUndegradedPlan(input, facts), degraded)) {
    const google = provider === 'google';
    add({
      key: `lockout_held:${provider}`, origin: 'capability', capabilityKey: CAPABILITY_FOR_TOOL[LOCKOUT_TOOL[provider]] ?? null,
      label: google
        ? `Suspend ${label}'s Google Workspace account by hand, after the mail steps`
        : `Disable ${label}'s Microsoft 365 account by hand, after the mail steps`,
      detail: `Breeze cannot run ${mailTools.join(', ')} in this organization, so it did not `
        + `${google ? 'suspend' : 'disable'} the account either: doing that first would leave this person's mail `
        + 'unanswered. Do the mail steps listed above by hand first, then '
        + (google
          ? 'suspend the user in the Google Admin console (Directory → Users → Suspend user).'
          : 'block sign-in in the Microsoft 365 admin centre (Users → Active users → Block sign-in).'),
    });
  }

  // 3. Exchange (spec §7.3) — whenever the effect was requested.
  const dest = mailDestination(input, facts);
  if ((fx.forwarding || fx.mailDelegate) && !dest) {
    add({
      key: 'choose_mail_destination', origin: 'discovery', capabilityKey: null,
      label: `Decide who receives ${label}'s mail`,
      detail: 'Forwarding or delegation was requested but no inheritor or forwarding address was given, so no '
        + 'mail routing was planned. Choose a destination and set it up by hand.',
    });
  }
  if (m365.present) {
    if (fx.forwarding) {
      add({
        key: 'm365_forwarding_manual', origin: 'capability', capabilityKey: 'm365.exchange.forwarding',
        label: `Forward ${label}'s Microsoft 365 mail${dest ? ` to ${dest}` : ''}`,
        detail: 'Breeze cannot do this yet — it needs Exchange Online PowerShell. In the Exchange admin centre '
          + 'open Recipients → Mailboxes, select this person, and set up email forwarding'
          + `${dest ? ` to ${dest}` : ''}. Blocking sign-in does not stop the mailbox receiving mail, so this `
          + 'still works after Breeze has disabled the account; do it promptly.',
      });
    }
    if (fx.mailDelegate) {
      add({
        key: 'm365_mailbox_delegate_manual', origin: 'capability', capabilityKey: 'm365.exchange.mailbox_delegate',
        label: `Grant mailbox access to ${label}'s Microsoft 365 mailbox${dest ? ` for ${dest}` : ''}`,
        detail: 'Breeze cannot do this yet — it needs Exchange Online PowerShell. In the Exchange admin centre '
          + 'open Recipients → Mailboxes, select this person, and grant Full Access under Mailbox delegation.',
      });
    }
    if (input.keepMailbox) {
      add({
        key: 'shared_mailbox_conversion', origin: 'capability',
        capabilityKey: 'm365.exchange.shared_mailbox_conversion',
        label: `Convert ${label}'s Microsoft 365 mailbox to a shared mailbox`,
        detail: 'Breeze cannot do this yet — it needs Exchange Online PowerShell. In the Exchange admin centre '
          + 'open Recipients → Mailboxes, select this person, and choose Convert to shared mailbox. Do this '
          + 'BEFORE removing the Microsoft 365 licence: removing the licence first starts the mailbox\'s 30-day '
          + 'deletion clock. Breeze has deliberately left the licence in place for this reason.',
      });
    }
  }

  // 4. Discovery-derived. ONE item per kind of group work, naming the groups —
  // never one per group: a person in 150 groups must not produce 150 items
  // (the manual list is capped; see `capManualWork`).
  if (fx.removeGroups) {
    const names = (gs: readonly { name: string }[]): string => clip(gs.map((g) => `"${g.name}"`).join(', '), 1500);
    const m365Unknown = m365.groups.filter((g) => g.ownership === 'unknown');
    if (m365Unknown.length > 0) {
      // D-R1-7: there is no M365 owners read, so ownership is never known.
      add({
        key: 'confirm_m365_group_owners', origin: 'discovery', capabilityKey: null,
        label: `Confirm ${m365Unknown.length} Microsoft 365 group(s) have another owner before ${label} is removed`,
        detail: 'Breeze cannot read Microsoft 365 group owners. In the Microsoft 365 admin centre open each of '
          + `these groups and confirm someone other than this person owns it; add an owner if not: ${names(m365Unknown)}.`,
      });
    }
    const m365Manual = m365.groups.filter((g) => g.dynamic || g.roleAssignable);
    if (m365Manual.length > 0) {
      add({
        key: 'manual_m365_group_removals', origin: 'discovery', capabilityKey: null,
        label: `Remove ${label} from ${m365Manual.length} Microsoft 365 group(s) by hand`,
        detail: 'Breeze cannot change these groups\' membership: a dynamic-membership group computes its members '
          + 'from user attributes (change the attribute or the rule), and a role-assignable group can only be '
          + `changed in the Entra admin centre. Groups: ${names(m365Manual)}.`,
      });
    }
    const googleSole = google.groups.filter((g) => g.ownership === 'sole');
    if (googleSole.length > 0) {
      add({
        key: 'reassign_google_group_owners', origin: 'discovery', capabilityKey: null,
        label: `Give ${googleSole.length} Google group(s) another owner — ${label} is the only owner`,
        detail: 'In the Google Admin console open each of these groups and add another owner before this person '
          + `is removed: ${names(googleSole)}.`,
      });
    }
    const googleNoEmail = google.groups.filter((g) => !g.email);
    if (googleNoEmail.length > 0) {
      add({
        key: 'manual_google_group_removals', origin: 'discovery', capabilityKey: null,
        label: `Remove ${label} from ${googleNoEmail.length} Google group(s) by hand`,
        detail: `Discovery did not return these Google groups' addresses, so Breeze did not plan their removal: ${names(googleNoEmail)}.`,
      });
    }
  }
  for (const flag of arr(facts.flags)) {
    const code = str(flag.code);
    if (!code) continue;
    const subject = str(flag.subject) ?? '';
    add({
      key: `discovery_flag:${code}:${subject}`, origin: 'discovery', capabilityKey: null,
      label: `Check by hand: ${code.replace(/_/g, ' ')}${subject ? ` (${subject})` : ''}`,
      detail: str(flag.detail) ?? 'Discovery could not confirm this automatically. Check it by hand.',
    });
  }
  // Admission found SOME account but a provider lookup failed: that provider
  // was never looked at, and the person may still have an account there.
  const admissionProblems = Array.isArray(facts.admissionProblems)
    ? facts.admissionProblems.filter((t): t is string => typeof t === 'string') : [];
  admissionProblems.forEach((problem, i) => {
    add({
      key: `admission_problem:${i}`, origin: 'discovery', capabilityKey: null,
      label: `Check by hand: an account lookup for ${label} failed`,
      detail: `When this task started, Breeze could not finish looking up this person's accounts: ${problem}. `
        + 'Breeze did not offboard anything at that provider. Find the account in that provider\'s admin console '
        + 'and offboard it by hand, or link the contact to the right account and start a new task.',
    });
  });
  // A provider that IS connected but holds no frozen account for this person:
  // usually right, but an address lookup misses an account whose sign-in name
  // differs from the contact's email. A person confirms it.
  for (const [provider, connection, present, name] of [
    ['m365', 'm365.connection', m365.present, 'Microsoft 365'],
    ['google', 'google.workspace.connection', google.present, 'Google Workspace'],
  ] as const) {
    if (present || readiness[connection] !== true) continue;
    // A frozen account that could not be READ already has its own flag item.
    if (arr(facts.flags).some((f) => (str(f.code) ?? '').startsWith(`${provider}_`))) continue;
    add({
      key: `confirm_no_account:${provider}`, origin: 'discovery', capabilityKey: null,
      label: `Confirm ${label} has no ${name} account`,
      detail: `${name} is connected, but Breeze found no account for this person there, so nothing was done in `
        + `${name}. If they have one under a different sign-in name, offboard it by hand (or link the contact to `
        + 'it and start a new task).',
    });
  }
  const truncated = Array.isArray(facts.truncated) ? facts.truncated.filter((t): t is string => typeof t === 'string') : [];
  for (const what of truncated) {
    add({
      key: `discovery_truncated:${what}`, origin: 'discovery', capabilityKey: null,
      label: `Review the rest of ${label}'s ${what} by hand`,
      detail: `Discovery listed only the first entries of ${what}; anything past that limit was not planned. `
        + 'Review the remainder in the provider\'s admin console.',
    });
  }

  // 5. Review flags (closed enum, validated before they reach here).
  for (const flag of reviewFlags) {
    add({
      key: `flag:${flag.code}:${flag.subject}`, origin: 'flag', capabilityKey: null,
      label: `Review: ${flag.code.replace(/_/g, ' ')} — ${flag.subject}`,
      detail: flag.detail,
    });
  }

  return [...items.values()];
}

/** The most checklist items one task creates (`manualWork.ts` refuses more). */
export const MANUAL_WORK_MAX_ITEMS = 64;

/**
 * Fit a manual list into `MANUAL_WORK_MAX_ITEMS` without losing anything
 * silently: the first `max - 1` items are kept as they are and the rest are
 * folded into ONE final item that names every one of them. Pure and
 * order-preserving, so index i means the same item on every wake.
 */
export function capManualWork(
  items: readonly IdentityManualWorkItem[],
  max: number = MANUAL_WORK_MAX_ITEMS,
): IdentityManualWorkItem[] {
  if (items.length <= max) return [...items];
  const kept = items.slice(0, max - 1);
  const rest = items.slice(max - 1);
  return [...kept, {
    key: 'overflow', origin: 'flag', capabilityKey: null,
    label: `Review ${rest.length} more item(s) listed in this step's details`,
    detail: clip(`This offboarding produced more checklist items than fit on one ticket. Do each of these by hand: `
      + rest.map((i) => i.label).join('; '), MAX_DETAIL_CHARS),
  }];
}

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

export const identityOffboardingRecipe: RecipeDefinition<IdentityOffboardingInput> = {
  key: IDENTITY_OFFBOARDING_WORKFLOW_KEY,
  version: IDENTITY_OFFBOARDING_WORKFLOW_VERSION,
  promptVersion: IDENTITY_OFFBOARDING_PROMPT_VERSION,
  gateClass: 'deterministic',
  targetKinds: ['contact', 'ticket', 'device'],
  requires: IDENTITY_OFFBOARDING_CAPABILITIES,
  inputSchema: identityOffboardingInputSchema,

  steps: Object.freeze({
    intake: { kind: 'reason', phase: 'investigate', next: 'confirm_identity' },
    // The mandatory human confirmation (spec §11 risk row 1). Not skippable by
    // any input, flag, policy or argument: no other step names `discover`.
    confirm_identity: { kind: 'human_work', phase: 'investigate', inputSchema: identityIntakeOutputSchema, next: 'discover' },
    discover: { kind: 'probe', phase: 'plan', next: 'review' },
    review: { kind: 'reason', phase: 'plan', next: 'effects' },
    // Propose → four-eyes approval → re-seal → not-before cutoff → ordered
    // walk, all inside E4's planEffectStep (D-R1-10, Todd's D1 = A).
    effects: { kind: 'effect', phase: 'execute', inputSchema: identityReviewOutputSchema, next: 'manual_work' },
    manual_work: { kind: 'human_work', phase: 'execute', next: 'verify_outcome' },
    verify_outcome: { kind: 'probe', phase: 'verify', next: 'document' },
    document: { kind: 'document', phase: 'document', terminal: true },
  }),

  /**
   * Sparse ON PURPOSE (E1's contract). The model proposes out of the two
   * `reason` steps and nowhere else; every other transition is
   * `StepDefinition.next`, resolved by the coordinator from server-side facts.
   * `discover` appears in NO permitted set — spec §11's first risk row as data.
   */
  permittedNextSteps: Object.freeze({
    intake: ['confirm_identity'],
    review: ['effects'],
  }),

  bounds: IDENTITY_OFFBOARDING_BOUNDS,
  buildPlan: buildIdentityOffboardingPlan,
  // R1a-0 recipe data.
  planningSnapshotStepKey: 'discover',
  entryStepKey: 'intake',
  unobservableEffects: IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS,

  /**
   * One operation per external effect. `toolName` is the EFFECT's tool and
   * `ordinal` its plan ordinal, so this is byte-for-byte the key
   * `effectDispatch.dispatchPlannedEffect` builds. The permanent
   * `(org_id, task_id, operation_key)` index is what makes a replay a no-op,
   * and E4's `planOrdinalFromOperationKey` parses the trailing `n<ordinal>`
   * back out at release; two spellings would defeat both. The workflow-key
   * fallback covers steps with no provider tool.
   */
  operationKey: (args) => buildTaskOperationKey({
    taskStepKey: args.stepKey,
    toolName: args.toolName ?? IDENTITY_OFFBOARDING_WORKFLOW_KEY,
    targetId: args.targetId,
    planRevision: args.planRevision,
    ordinal: args.ordinal,
  }),
};
