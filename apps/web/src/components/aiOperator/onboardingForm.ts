/**
 * Pure state and draft-reading helpers for the `identity_onboarding` start
 * form (Operator Recipe Library W07 R2b, Task 17). No React, no fetch: the
 * rules here are the ones a wrong-person or wrong-jurisdiction error would
 * slip through, so they are small and tested on their own terms.
 *
 * What the draft can and cannot tell the form (R2a, `AiOperatorIdentity
 * OnboardingTaskDraftDto`): one M365 sign-in-name lookup, one Google address
 * lookup and one M365 licence list. It reads no group and no model-after
 * person. Everything below derives from those three reads and nothing else;
 * where they are silent the form says "could not be checked", never "free".
 */
import type {
  AiOperatorIdentityOnboardingTaskDraftDto,
  IdentityOnboardingInput,
} from '@breeze/shared';

export const ONBOARDING_RECIPE_KEY = 'identity_onboarding';

export interface M365FormBlock {
  userPrincipalName: string;
  mailNickname: string;
  /** Once the technician types in the nickname, the UPN stops overwriting it. */
  mailNicknameEdited: boolean;
  usageLocation: string;
  skuIds: string[];
  groupIds: string[];
}

export interface GoogleFormBlock {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  orgUnitPath: string;
  licenses: Array<{ productId: string; skuId: string }>;
  groupEmails: string[];
}

export interface OnboardingFormValue {
  displayName: string;
  jobTitle: string;
  siteId: string;
  managerContactId: string;
  modelAfterContactId: string;
  /** `<input type="datetime-local">` value (local wall time); '' = now. */
  startAt: string;
  /**
   * The browser reports a half-typed `datetime-local` as '' — which would
   * otherwise read as "start now". Set from `validity.badInput`; blocks the
   * preview until the date is completed or cleared.
   */
  startAtIncomplete: boolean;
  /** null = the provider is switched off. There is no hidden-but-kept block. */
  m365: M365FormBlock | null;
  google: GoogleFormBlock | null;
}

export function emptyM365Block(): M365FormBlock {
  // usageLocation starts EMPTY: never the browser locale (a licence's
  // jurisdiction), and no org country reaches these launch surfaces.
  return { userPrincipalName: '', mailNickname: '', mailNicknameEdited: false, usageLocation: '', skuIds: [], groupIds: [] };
}

export function emptyGoogleBlock(): GoogleFormBlock {
  return { primaryEmail: '', givenName: '', familyName: '', orgUnitPath: '', licenses: [], groupEmails: [] };
}

export function initialOnboardingValue(managerContactId: string | null): OnboardingFormValue {
  return {
    displayName: '', jobTitle: '', siteId: '', managerContactId: managerContactId ?? '', modelAfterContactId: '',
    startAt: '', startAtIncomplete: false, m365: null, google: null,
  };
}

/** The mailNickname a UPN suggests: its local part, reduced to Graph's alphabet. */
export function nicknameFromUpn(upn: string): string {
  const local = upn.split('@')[0] ?? '';
  return local.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

/** Set the UPN, carrying the nickname along until the technician has edited it. */
export function withUpn(block: M365FormBlock, upn: string): M365FormBlock {
  return block.mailNicknameEdited
    ? { ...block, userPrincipalName: upn }
    : { ...block, userPrincipalName: upn, mailNickname: nicknameFromUpn(upn) };
}

/** `datetime-local` → ISO instant, or null for empty / unparseable. */
export function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const blank = (s: string): string | null => (s.trim() ? s.trim() : null);

/**
 * The wire input, built ONLY from the visible state: a switched-off provider
 * is `null`, because its block no longer exists in the state at all.
 */
export function toOnboardingInput(v: OnboardingFormValue): Record<string, unknown> {
  return {
    displayName: v.displayName.trim(),
    jobTitle: blank(v.jobTitle),
    siteId: blank(v.siteId),
    managerContactId: blank(v.managerContactId),
    modelAfterContactId: blank(v.modelAfterContactId),
    startAt: localToIso(v.startAt),
    m365: v.m365 === null ? null : {
      userPrincipalName: v.m365.userPrincipalName.trim(),
      mailNickname: v.m365.mailNickname.trim(),
      usageLocation: v.m365.usageLocation.trim().toUpperCase(),
      skuIds: v.m365.skuIds,
      groupIds: v.m365.groupIds,
    },
    google: v.google === null ? null : {
      primaryEmail: v.google.primaryEmail.trim(),
      givenName: v.google.givenName.trim(),
      familyName: v.google.familyName.trim(),
      orgUnitPath: blank(v.google.orgUnitPath),
      licenses: v.google.licenses,
      groupEmails: v.google.groupEmails,
    },
  };
}

const DAY_MS = 86_400_000;

/** True when `startAt` is past the server-reported deadline (whole days from now). */
export function startAtBeyondDeadline(startAtLocal: string, deadlineDays: number, now: number = Date.now()): boolean {
  const iso = localToIso(startAtLocal);
  if (iso === null) return false;
  return Date.parse(iso) > now + deadlineDays * DAY_MS;
}

// ---------------------------------------------------------------------------
// Reading the draft
// ---------------------------------------------------------------------------

type Draft = AiOperatorIdentityOnboardingTaskDraftDto;

const canon = (s: string): string => s.trim().toLowerCase();

/** Flags whose subject is this value (case-insensitive), verbatim. */
export function flagsFor(draft: Draft, subject: string): Draft['flags'] {
  const want = canon(subject);
  return want ? draft.flags.filter((f) => canon(f.subject) === want) : [];
}

/** `manual`: the create tool is degraded for this org, so no create was planned or weighed. */
export type NameAvailability = 'available' | 'taken' | 'unchecked' | 'manual';

const TAKEN_CODES: Record<'m365' | 'google', string> = { m365: 'upn_collision', google: 'email_collision' };
const CREATE_TOOL: Record<'m365' | 'google', string | null> = { m365: 'm365_create_user', google: null };

/**
 * What the draft learned about the requested sign-in name / address.
 *
 * `available` ONLY when the draft planned the creation for this exact name
 * (M365), i.e. the server read it as strictly free. Google has no create tool,
 * so a Google address is `available` only when the draft provisions it (which
 * it does only on a strictly-free read). Anything else — a failed read, a
 * degraded create, a name the draft never saw — is `unchecked`: nobody
 * verified it, so the form must not say it is free.
 */
export function nameAvailability(draft: Draft, provider: 'm365' | 'google', name: string): NameAvailability | null {
  const want = canon(name);
  if (!want) return null;
  const sent = provider === 'm365' ? draft.input?.m365?.userPrincipalName : draft.input?.google?.primaryEmail;
  if (typeof sent === 'string' && canon(sent) !== want) return null; // the draft was for another name
  if (draft.flags.some((f) => f.code === TAKEN_CODES[provider] && canon(f.subject) === want)) return 'taken';
  const createTool = CREATE_TOOL[provider];
  if (createTool && (draft.workflow?.degradedEffects ?? []).includes(createTool)) return 'manual';
  const planned = createTool
    ? draft.createPlanPreview.some((e) => e.toolName === createTool && canon(e.principalLabel) === want)
    : draft.provisionPlanPreview.some((e) => e.provider === 'google' && canon(e.principalLabel) === want);
  return planned ? 'available' : 'unchecked';
}

/** Flag codes that mean the M365 licence list was not read (failure, consent, permission). */
const SEAT_READ_FAILURE = /^m365_(seats_read_failed|.*consent.*|.*permission.*)$/;

/**
 * The M365 licences the draft would assign. `null` when the draft cannot say:
 * no M365 account would be created (taken, unchecked or degraded), so no seat
 * was weighed and no SKU may be badged "no seats".
 */
export function plannedSkuIds(draft: Draft): Set<string> | null {
  const creates = draft.createPlanPreview.some((e) => e.toolName === 'm365_create_user');
  if (!creates) return null;
  // A licence step done by hand for this org was never weighed against seats.
  if ((draft.workflow?.degradedEffects ?? []).includes('m365_assign_license')) return null;
  // A failed or unauthorized licence read is its own flag, rendered verbatim; it is not "no seats".
  if (draft.flags.some((f) => SEAT_READ_FAILURE.test(f.code))) return null;
  const out = new Set<string>();
  for (const e of draft.provisionPlanPreview) {
    if (e.toolName !== 'm365_assign_license') continue;
    const ids = (e.arguments as { skuIds?: unknown }).skuIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') out.add(canon(id));
  }
  return out;
}

/** True when the draft planned no seat for a SKU it did weigh (D-R2-5: still selectable). */
export function skuHasNoSeat(draft: Draft | null, skuId: string): boolean {
  if (!draft) return false;
  const planned = plannedSkuIds(draft);
  if (planned === null) return false;
  const sentSkus = draft.input?.m365?.skuIds;
  if (Array.isArray(sentSkus) && !sentSkus.some((s) => canon(s) === canon(skuId))) return false; // not in that draft
  return !planned.has(canon(skuId));
}

/** True when the draft turned this group into a technician's checklist item. */
export function groupNeedsTechnician(draft: Draft | null, groupKey: string): boolean {
  if (!draft) return false;
  const want = `manual_group_add:${canon(groupKey)}`;
  return draft.manualWork.some((i) => canon(i.key) === want);
}

/** Effects in plan order (by ordinal). */
export function inPlanOrder<E extends { ordinal: number }>(effects: readonly E[]): E[] {
  return [...effects].sort((a, b) => a.ordinal - b.ordinal);
}

export type { IdentityOnboardingInput };
