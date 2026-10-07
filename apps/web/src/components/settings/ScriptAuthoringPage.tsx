import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, ShieldAlert } from 'lucide-react';
import type {
  EffectiveScriptPolicyDto,
  RiskTier,
  ScriptLaneStateDto,
  ScriptPolicyDto,
  TouchClass,
} from '@breeze/shared';
import {
  LANE_HARD_DENIED_CLASSES,
  TOUCH_CLASSES,
  partnerScriptCeilingGrantResource,
  scriptLaneEnableGrantResource,
  scriptLaneWideningGrantResource,
  type ScriptLaneEnableSaveBody,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgScope } from '@/hooks/useOrgScope';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { mintStepUpGrant, StepUpMintError, type StepUpReauth } from '../../lib/mfaStepUp';
import StepUpPrompt, { pickReauthTier, type ReauthTier } from './StepUpPrompt';
import { listField, numberField } from './aiAgents/agentFields';
import { useStableT } from '@/lib/i18n/useStableT';
import ModelDefaultsLink from './aiModels/ModelDefaultsLink';

/**
 * Classes the unattended lane only executes on Windows (a restore checkpoint
 * is taken first — RESTORE_CHECKPOINT_CLASSES, apps/api/src/services/
 * deviceRecovery/restoreCheckpoint.ts). Mirrored here rather than imported: it
 * is API-internal, and the web only needs it to badge these three classes.
 */
const WINDOWS_ONLY_CLASSES: ReadonlySet<TouchClass> = new Set<TouchClass>([
  'registry', 'services', 'files_system',
]);

/** Literal keys so the i18n key-usage scanner can verify every class label
 *  statically (a `t(\`scriptAuthoringPage.class.${cls}\`)` template would be a
 *  dynamic key it cannot check) — same convention as AiUsagePage's
 *  PERIOD_LABEL_KEYS. */
const CLASS_LABEL_KEYS: Record<TouchClass, string> = {
  registry: 'scriptAuthoringPage.class.registry',
  services: 'scriptAuthoringPage.class.services',
  processes: 'scriptAuthoringPage.class.processes',
  files_system: 'scriptAuthoringPage.class.files_system',
  files_user: 'scriptAuthoringPage.class.files_user',
  temp_files: 'scriptAuthoringPage.class.temp_files',
  network_egress: 'scriptAuthoringPage.class.network_egress',
  firewall: 'scriptAuthoringPage.class.firewall',
  credentials: 'scriptAuthoringPage.class.credentials',
  users_groups: 'scriptAuthoringPage.class.users_groups',
  packages: 'scriptAuthoringPage.class.packages',
  scheduled_tasks: 'scriptAuthoringPage.class.scheduled_tasks',
  disk: 'scriptAuthoringPage.class.disk',
  boot: 'scriptAuthoringPage.class.boot',
  security_tooling: 'scriptAuthoringPage.class.security_tooling',
  dns_cache: 'scriptAuthoringPage.class.dns_cache',
  printing: 'scriptAuthoringPage.class.printing',
  browser: 'scriptAuthoringPage.class.browser',
  shell_eval: 'scriptAuthoringPage.class.shell_eval',
};

interface ProtectedResourcesDraft {
  services: string;
  paths: string;
  registryKeys: string;
  deviceTags: string;
}

interface OrgDraft {
  proposingEnabled: boolean;
  unattendedEnabled: boolean;
  maxUnattendedRiskTier: 'low' | 'medium';
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  protectedResources: ProtectedResourcesDraft;
}

interface PartnerDraft {
  proposingEnabled: boolean;
  unattendedAllowed: boolean;
  maxUnattendedRiskTier: 'low' | 'medium';
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  protectedResources: ProtectedResourcesDraft;
}

const EMPTY_RESOURCES: ProtectedResourcesDraft = { services: '', paths: '', registryKeys: '', deviceTags: '' };

function toLines(list: string[] | undefined): string {
  return (list ?? []).join('\n');
}

function fromLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function resourcesToDraft(r: ScriptPolicyDto['protectedResources'] | undefined): ProtectedResourcesDraft {
  if (!r) return EMPTY_RESOURCES;
  return {
    services: toLines(r.services),
    paths: toLines(r.paths),
    registryKeys: toLines(r.registryKeys),
    deviceTags: toLines(r.deviceTags),
  };
}

function normalizedTier(tier: RiskTier | undefined): 'low' | 'medium' {
  return tier === 'medium' ? 'medium' : 'low';
}

function orgDraftFromPolicy(policy: ScriptPolicyDto | null, effective: EffectiveScriptPolicyDto): OrgDraft {
  return {
    proposingEnabled: policy?.proposingEnabled ?? effective.proposingEnabled,
    unattendedEnabled: policy?.unattendedEnabled ?? false,
    maxUnattendedRiskTier: normalizedTier(policy?.maxUnattendedRiskTier),
    unattendedAllowedClasses: policy?.unattendedAllowedClasses ?? [],
    maxUnattendedPerHour: policy?.maxUnattendedPerHour ?? Math.min(10, effective.maxUnattendedPerHour),
    protectedResources: resourcesToDraft(policy?.protectedResources),
  };
}

function partnerDraftFromPolicy(policy: ScriptPolicyDto | null): PartnerDraft {
  return {
    proposingEnabled: policy?.proposingEnabled ?? true,
    unattendedAllowed: policy?.unattendedAllowed ?? false,
    maxUnattendedRiskTier: normalizedTier(policy?.maxUnattendedRiskTier),
    unattendedAllowedClasses: policy?.unattendedAllowedClasses ?? [],
    maxUnattendedPerHour: policy?.maxUnattendedPerHour ?? 10,
    protectedResources: resourcesToDraft(policy?.protectedResources),
  };
}

interface OrgGetResponse {
  policy: ScriptPolicyDto | null;
  effective: EffectiveScriptPolicyDto;
  partnerCeilingPresent: boolean;
  laneState: ScriptLaneStateDto;
}

interface PartnerGetResponse {
  policy: ScriptPolicyDto | null;
  canManage: boolean;
  /** The caller's partner — what the ceiling step-up grant is bound to (#8112). */
  partnerId?: string | null;
}

type LaneGrantOperation = 'ai_script_lane_grant' | 'ai_partner_script_ceiling_grant';

/** A save the server refused because it needs a step-up grant the request did
 *  not carry. The web never reads ENABLE_2FA, so this 403 — not a client-side
 *  guess — is what reveals the prompt for a widening save or a ceiling change
 *  (same discovery as MaintenanceModeDialog); a 2FA-off deployment just saves. */
function isStepUpRequired(err: unknown): boolean {
  return err instanceof ActionError && err.status === 403 && err.code === 'STEP_UP_REQUIRED';
}

function draftValues(draft: OrgDraft | PartnerDraft): ScriptLaneEnableSaveBody {
  return {
    proposingEnabled: draft.proposingEnabled,
    maxUnattendedRiskTier: draft.maxUnattendedRiskTier,
    unattendedAllowedClasses: draft.unattendedAllowedClasses,
    maxUnattendedPerHour: draft.maxUnattendedPerHour,
    protectedResources: {
      services: fromLines(draft.protectedResources.services),
      paths: fromLines(draft.protectedResources.paths),
      registryKeys: fromLines(draft.protectedResources.registryKeys),
      deviceTags: fromLines(draft.protectedResources.deviceTags),
    },
  };
}

/** Discovers the strongest available step-up factor the same way
 *  MaintenanceModeDialog does — GET /users/me + GET /auth/passkeys — since
 *  this page (unlike that dialog) always needs the grant BEFORE the first
 *  submit rather than discovering it off a 403. */
async function discoverReauthTier(): Promise<ReauthTier | null> {
  try {
    const [userRes, passkeyRes] = await Promise.all([
      fetchWithAuth('/users/me'),
      fetchWithAuth('/auth/passkeys'),
    ]);
    if (!userRes.ok || !passkeyRes.ok) return null;
    const user = await userRes.json();
    const passkeyData = await passkeyRes.json();
    const passkeys = Array.isArray(passkeyData) ? passkeyData : passkeyData?.passkeys;
    if (!user || typeof user !== 'object' || !('mfaMethod' in user) || !Array.isArray(passkeys)) return null;
    return pickReauthTier(passkeys.length, user.mfaMethod);
  } catch {
    return null;
  }
}

export default function ScriptAuthoringPage() {
  const { t } = useTranslation('settings');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const orgScope = useOrgScope();
  const orgId = orgScope.scope === 'org' ? orgScope.orgId : null;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [orgPolicy, setOrgPolicy] = useState<ScriptPolicyDto | null>(null);
  const [effective, setEffective] = useState<EffectiveScriptPolicyDto | null>(null);
  const [partnerCeilingPresent, setPartnerCeilingPresent] = useState(true);
  const [laneState, setLaneState] = useState<ScriptLaneStateDto | null>(null);
  const [orgDraft, setOrgDraft] = useState<OrgDraft | null>(null);
  const [orgSaving, setOrgSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  // The reauth code box only shows once tier resolves to 'totp'; a passkey
  // tier mints straight from the browser ceremony with no typed input.
  const [reauthCode, setReauthCode] = useState('');
  const [reauthTier, setReauthTier] = useState<ReauthTier | null>(null);
  const [resolvingReauth, setResolvingReauth] = useState(false);
  // Resetting an open lane is its own step-up: it can happen while the lane is
  // already enabled, so it cannot borrow the enable-path's code box (#5683).
  // Its own code lives here so a half-typed enable code can never be minted
  // against the reset, or the other way round.
  const [resetStepUpOpen, setResetStepUpOpen] = useState(false);
  const [resetCode, setResetCode] = useState('');
  // Set when the server 403s STEP_UP_REQUIRED on a save that is NOT an enable
  // — i.e. it widens an already-enabled lane (#8096). The next Save mints a
  // grant bound to the widening delta.
  const [orgWideningStepUpOpen, setOrgWideningStepUpOpen] = useState(false);

  const [partnerPolicy, setPartnerPolicy] = useState<ScriptPolicyDto | null>(null);
  const [partnerCanManage, setPartnerCanManage] = useState(false);
  const [partnerFetchFailed, setPartnerFetchFailed] = useState(false);
  const [partnerDraft, setPartnerDraft] = useState<PartnerDraft | null>(null);
  const [partnerSaving, setPartnerSaving] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  // The partner ceiling's own step-up (#8112): revealed by a 403
  // STEP_UP_REQUIRED on Save, with its own code so a half-typed org code can
  // never be minted against the ceiling, or the other way round.
  const [partnerStepUpOpen, setPartnerStepUpOpen] = useState(false);
  const [partnerCode, setPartnerCode] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orgRes, partnerRes] = await Promise.all([
        orgId ? fetchWithAuth('/ai/script-policy') : Promise.resolve(null),
        fetchWithAuth('/partner/ai/script-policy'),
      ]);

      if (orgRes && orgRes.ok) {
        const body = (await orgRes.json()) as OrgGetResponse;
        setOrgPolicy(body.policy);
        setEffective(body.effective);
        setPartnerCeilingPresent(body.partnerCeilingPresent);
        setLaneState(body.laneState);
        setOrgDraft(orgDraftFromPolicy(body.policy, body.effective));
      } else if (orgRes) {
        setError(stableT('scriptAuthoringPage.loadFailed'));
      }

      // A 403 here is EXPECTED for an org-scoped token — it never means
      // "management access" for this session, so the partner card renders
      // read-only from the org response's effective/ceiling data instead of
      // surfacing an error.
      if (partnerRes.ok) {
        const body = (await partnerRes.json()) as PartnerGetResponse;
        setPartnerPolicy(body.policy);
        setPartnerCanManage(body.canManage);
        setPartnerFetchFailed(false);
        setPartnerId(body.partnerId ?? null);
        setPartnerDraft(partnerDraftFromPolicy(body.policy));
      } else {
        setPartnerFetchFailed(true);
        setPartnerCanManage(false);
        setPartnerPolicy(null);
        setPartnerId(null);
        setPartnerDraft(null);
      }
    } catch {
      setError(stableT('scriptAuthoringPage.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [orgId, orgScope.scope, stableT]);

  useEffect(() => {
    void load();
    // `load` is itself memoized on [orgId, orgScope.scope, stableT], and
    // `stableT` never changes identity (#3632), so this re-runs only when the
    // org or scope actually changes, not on a locale switch.
  }, [load]);

  const ensureReauthTier = useCallback(async (): Promise<ReauthTier | null> => {
    if (reauthTier) return reauthTier;
    setResolvingReauth(true);
    try {
      const tier = await discoverReauthTier();
      setReauthTier(tier);
      return tier;
    } finally {
      setResolvingReauth(false);
    }
  }, [reauthTier]);

  // Discover the reauth tier as soon as the org is about to turn the lane on,
  // so the (possible) TOTP code box is visible before Save is even clickable.
  const handleUnattendedToggle = useCallback((next: boolean) => {
    setOrgDraft((prev) => (prev ? { ...prev, unattendedEnabled: next } : prev));
    if (next && !(orgPolicy?.unattendedEnabled ?? false)) {
      void ensureReauthTier();
    }
  }, [orgPolicy, ensureReauthTier]);

  const mintLaneGrant = useCallback(async (
    resource: object,
    code: string,
    operation: LaneGrantOperation = 'ai_script_lane_grant',
  ): Promise<string> => {
    const tier = await ensureReauthTier();
    if (!tier || tier === 'password') {
      // null = factor discovery itself failed, not "no factor".
      throw new StepUpMintError('unavailable', tier ? t('scriptAuthoringPage.stepUp.noFactor') : t('scriptAuthoringPage.saveFailed'));
    }
    const reauth: StepUpReauth = tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code };
    return mintStepUpGrant({ operation, resource, reauth });
  }, [ensureReauthTier, t]);

  /** Opens a save's step-up prompt after the server asked for one. Resolves
   *  the factor first so the code box (TOTP) or passkey note is what shows;
   *  an account with neither gets told so instead of an unusable prompt. */
  const revealStepUp = useCallback(async (open: () => void) => {
    const tier = await ensureReauthTier();
    if (!tier || tier === 'password') {
      // null = factor discovery itself failed (network, /users/me error), which
      // must not read as "your account has no factor".
      setError(tier ? t('scriptAuthoringPage.stepUp.noFactor') : t('scriptAuthoringPage.saveFailed'));
      return;
    }
    open();
  }, [ensureReauthTier, t]);

  const handleOrgSave = useCallback(async () => {
    if (!orgDraft || !orgId) return;
    const wasEnabled = orgPolicy?.unattendedEnabled ?? false;
    const isEnabling = orgDraft.unattendedEnabled && !wasEnabled;
    const values = draftValues(orgDraft);
    // Enabling binds the grant to every value this save arms (#7873); a save
    // the server already flagged as WIDENING an enabled lane binds it to the
    // widening delta against the saved row instead (#8096).
    const resource = isEnabling
      ? scriptLaneEnableGrantResource(orgId, values)
      : orgWideningStepUpOpen && wasEnabled && orgDraft.unattendedEnabled && orgPolicy
        ? scriptLaneWideningGrantResource(orgId, orgPolicy, values)
        : null;
    if (resource && !isEnabling && reauthTier === 'totp' && reauthCode.length === 0) return;
    setOrgSaving(true);
    setError(null);
    let stepUpGrant: string | undefined;
    try {
      if (resource) {
        try {
          stepUpGrant = await mintLaneGrant(resource, reauthCode);
        } catch (err) {
          setError(err instanceof Error ? err.message : t('scriptAuthoringPage.saveFailed'));
          return;
        }
      }
      const body: Record<string, unknown> = {
        ...values,
        // Only send the lane switch when it changes: the server treats any
        // `unattendedEnabled: true` as the enable transition and requires a
        // grant, so re-sending an unchanged `true` would 403 every later save.
        ...(orgDraft.unattendedEnabled !== wasEnabled ? { unattendedEnabled: orgDraft.unattendedEnabled } : {}),
        ...(stepUpGrant ? { stepUpGrant } : {}),
      };
      const result = await runAction<OrgGetResponse | { policy: ScriptPolicyDto }>({
        request: () => fetchWithAuth('/ai/script-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        errorFallback: t('scriptAuthoringPage.saveFailed'),
        successMessage: t('scriptAuthoringPage.saved'),
        // A widening save's first, grant-less attempt is how the prompt is
        // discovered — not an error worth a toast.
        suppressErrorToast: (status, code) => !stepUpGrant && status === 403 && code === 'STEP_UP_REQUIRED',
      });
      setReauthCode('');
      setOrgWideningStepUpOpen(false);
      if ('policy' in result && result.policy) setOrgPolicy(result.policy);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // Only the FIRST grant-less 403 opens the prompt. A repeat one means the
      // page could not build a grant the server accepts (e.g. its copy of the
      // saved row is stale) — re-opening the same prompt would loop silently.
      if (!stepUpGrant && !isEnabling && !orgWideningStepUpOpen && isStepUpRequired(err)) {
        await revealStepUp(() => setOrgWideningStepUpOpen(true));
        return;
      }
      if (isStepUpRequired(err) && !stepUpGrant) showToast({ message: t('scriptAuthoringPage.saveFailed'), type: 'error' });
      if (!(err instanceof ActionError)) showToast({ message: t('scriptAuthoringPage.saveFailed'), type: 'error' });
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.saveFailed'));
    } finally {
      setOrgSaving(false);
    }
  }, [orgDraft, orgId, orgPolicy, orgWideningStepUpOpen, reauthTier, mintLaneGrant, revealStepUp, reauthCode, load, t]);

  const handlePartnerSave = useCallback(async () => {
    if (!partnerDraft) return;
    const wasAllowed = partnerPolicy?.unattendedAllowed ?? false;
    const values = draftValues(partnerDraft);
    // Only mint once the server has asked (a 2FA-off deployment never does).
    // The resource mirrors the route's enable/widen branches exactly (#8112).
    const resource = partnerStepUpOpen && partnerId
      ? partnerScriptCeilingGrantResource({
        partnerId,
        allowed: partnerDraft.unattendedAllowed,
        saved: partnerPolicy ? { ...partnerPolicy, unattendedAllowed: wasAllowed } : null,
        body: values,
      })
      : null;
    if (resource && reauthTier === 'totp' && partnerCode.length === 0) return;
    setPartnerSaving(true);
    setError(null);
    let stepUpGrant: string | undefined;
    try {
      if (resource) {
        try {
          stepUpGrant = await mintLaneGrant(resource, partnerCode, 'ai_partner_script_ceiling_grant');
        } catch (err) {
          setError(err instanceof Error ? err.message : t('scriptAuthoringPage.saveFailed'));
          return;
        }
      }
      const body: Record<string, unknown> = {
        ...values,
        // Only send the ceiling switch when it changes: the route treats any
        // `unattendedAllowed: true` as the enable transition, so re-sending an
        // unchanged `true` would demand a grant on every later save.
        ...(partnerDraft.unattendedAllowed !== wasAllowed ? { unattendedAllowed: partnerDraft.unattendedAllowed } : {}),
        ...(stepUpGrant ? { stepUpGrant } : {}),
      };
      await runAction({
        request: () => fetchWithAuth('/partner/ai/script-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        errorFallback: t('scriptAuthoringPage.saveFailed'),
        successMessage: t('scriptAuthoringPage.saved'),
        suppressErrorToast: (status, code) => !stepUpGrant && status === 403 && code === 'STEP_UP_REQUIRED',
      });
      setPartnerCode('');
      setPartnerStepUpOpen(false);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // Only the FIRST grant-less 403 opens the prompt; see handleOrgSave.
      if (!stepUpGrant && !partnerStepUpOpen && isStepUpRequired(err)) {
        await revealStepUp(() => setPartnerStepUpOpen(true));
        return;
      }
      if (isStepUpRequired(err) && !stepUpGrant) showToast({ message: t('scriptAuthoringPage.saveFailed'), type: 'error' });
      if (!(err instanceof ActionError)) showToast({ message: t('scriptAuthoringPage.saveFailed'), type: 'error' });
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.saveFailed'));
    } finally {
      setPartnerSaving(false);
    }
  }, [partnerDraft, partnerPolicy, partnerId, partnerStepUpOpen, reauthTier, partnerCode, mintLaneGrant, revealStepUp, load, t]);

  const handleReset = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    // A TOTP approver has to type a code first: minting straight away sends an
    // empty one and the step-up route 400s `Invalid code` (#5683). The first
    // click resolves the factor and reveals the box; the second one mints.
    // A passkey approver needs no typed input — the browser ceremony is the
    // proof — so that tier goes straight through.
    const tier = await ensureReauthTier();
    if (tier === 'totp' && resetCode.length === 0) {
      setResetStepUpOpen(true);
      return;
    }
    setResetting(true);
    try {
      let stepUpGrant: string;
      try {
        stepUpGrant = await mintLaneGrant({ orgId, unattendedEnabled: true, reset: true }, resetCode);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('scriptAuthoringPage.lane.resetFailed'));
        return;
      }
      const result = await runAction<{ laneState: ScriptLaneStateDto }>({
        request: () => fetchWithAuth('/ai/script-lane/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepUpGrant }) }),
        errorFallback: t('scriptAuthoringPage.lane.resetFailed'),
        successMessage: t('scriptAuthoringPage.lane.resetSuccess'),
      });
      setLaneState(result.laneState);
      setResetCode('');
      setResetStepUpOpen(false);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ message: t('scriptAuthoringPage.lane.resetFailed'), type: 'error' });
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.lane.resetFailed'));
    } finally {
      setResetting(false);
    }
  }, [orgId, mintLaneGrant, ensureReauthTier, resetCode, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const orgIsEnabling = !!orgDraft?.unattendedEnabled && !(orgPolicy?.unattendedEnabled ?? false);
  const usableTier = reauthTier === 'totp' || reauthTier === 'passkey';
  const showOrgStepUp = (orgIsEnabling || orgWideningStepUpOpen) && usableTier;
  const showPartnerStepUp = partnerStepUpOpen && usableTier;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('scriptAuthoringPage.title')}</h1>
        <p className="text-muted-foreground">{t('scriptAuthoringPage.subtitle')}</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="script-authoring-error">
          {error}
        </div>
      )}

      {laneState?.state === 'open' && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-4" data-testid="script-lane-banner">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="flex-1 space-y-2">
              <p className="text-sm font-semibold">{t('scriptAuthoringPage.lane.openTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('scriptAuthoringPage.lane.openBody', { reason: laneState.openedReason ?? '' })}
              </p>
              {resetStepUpOpen && reauthTier && reauthTier !== 'password' && (
                <div className="space-y-2 rounded-md border bg-background p-3" data-testid="script-lane-reset-stepup">
                  <p className="text-sm font-medium">{t('scriptAuthoringPage.stepUp.title')}</p>
                  <p className="text-xs text-muted-foreground">{t('scriptAuthoringPage.lane.resetStepUpBody')}</p>
                  <StepUpPrompt
                    tier={reauthTier}
                    reauthValue={resetCode}
                    onChange={setResetCode}
                    disabled={resetting}
                  />
                </div>
              )}
              <button
                type="button"
                data-testid="script-lane-reset"
                onClick={() => void handleReset()}
                // `resolvingReauth` counts as busy: the first click awaits the
                // factor-discovery round trip BEFORE `resetting` is set, so
                // without it the button sits unchanged and re-clickable for two
                // requests and a double-click fires concurrent resets (#5683).
                disabled={resetting || resolvingReauth || !orgId}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {resetting || resolvingReauth ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('scriptAuthoringPage.lane.reset')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 space-y-4" data-testid="script-authoring-partner-card">
        <div>
          <h2 className="text-lg font-semibold">{t('scriptAuthoringPage.partnerCard.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('scriptAuthoringPage.partnerCard.description')}</p>
        </div>

        {!partnerCanManage && (
          <p className="text-xs text-muted-foreground italic">{t('scriptAuthoringPage.partnerCard.readOnly')}</p>
        )}

        {partnerFetchFailed || !partnerDraft ? (
          effective && (
            <PartnerCeilingSummary effective={effective} t={t} />
          )
        ) : (
          <PartnerForm
            draft={partnerDraft}
            onChange={setPartnerDraft}
            disabled={!partnerCanManage || partnerSaving}
            t={t}
          />
        )}

        {partnerCanManage && partnerDraft && showPartnerStepUp && (
          <div className="space-y-2 rounded-md border p-3" data-testid="script-partner-stepup">
            <p className="text-sm font-medium">{t('scriptAuthoringPage.stepUp.title')}</p>
            <p className="text-xs text-muted-foreground">{t('scriptAuthoringPage.stepUp.ceilingBody')}</p>
            <StepUpPrompt
              tier={reauthTier as ReauthTier}
              reauthValue={partnerCode}
              onChange={setPartnerCode}
              disabled={partnerSaving}
            />
          </div>
        )}

        {partnerCanManage && partnerDraft && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="script-partner-save"
              onClick={() => void handlePartnerSave()}
              disabled={partnerSaving || resolvingReauth}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {partnerSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t('scriptAuthoringPage.save')}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-6 space-y-4" data-testid="script-authoring-org-card">
        <div>
          <h2 className="text-lg font-semibold">{t('scriptAuthoringPage.orgCard.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('scriptAuthoringPage.orgCard.description')}</p>
        </div>

        {!partnerCeilingPresent && (
          <p className="text-xs text-amber-600 dark:text-amber-400 italic">{t('scriptAuthoringPage.partnerCard.missing')}</p>
        )}

        {!orgId || !orgDraft || !effective ? (
          <p className="text-sm text-muted-foreground">{t('scriptAuthoringPage.orgCard.noOrgSelected')}</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orgDraft.proposingEnabled}
                onChange={(e) => setOrgDraft({ ...orgDraft, proposingEnabled: e.target.checked })}
              />
              {t('scriptAuthoringPage.fields.proposingEnabled')}
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="script-unattended-enabled"
                checked={orgDraft.unattendedEnabled}
                onChange={(e) => handleUnattendedToggle(e.target.checked)}
              />
              {t('scriptAuthoringPage.fields.unattendedEnabled')}
            </label>

            {resolvingReauth && (
              <p className="text-xs text-muted-foreground">{t('scriptAuthoringPage.loading')}</p>
            )}
            {showOrgStepUp && (
              <div className="space-y-2 rounded-md border p-3" data-testid="script-org-stepup">
                <p className="text-sm font-medium">{t('scriptAuthoringPage.stepUp.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {orgIsEnabling ? t('scriptAuthoringPage.stepUp.body') : t('scriptAuthoringPage.stepUp.wideningBody')}
                </p>
                <StepUpPrompt
                  tier={reauthTier as ReauthTier}
                  reauthValue={reauthCode}
                  onChange={setReauthCode}
                  disabled={orgSaving}
                />
              </div>
            )}

            <label className="block text-sm">
              <span className="font-medium">{t('scriptAuthoringPage.fields.maxRiskTier')}</span>
              <select
                data-testid="script-max-risk-tier"
                value={orgDraft.maxUnattendedRiskTier}
                onChange={(e) => setOrgDraft({ ...orgDraft, maxUnattendedRiskTier: e.target.value as 'low' | 'medium' })}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="low">{t('scriptAuthoringPage.tier.low')}</option>
                <option value="medium" disabled={effective.maxUnattendedRiskTier === 'low'}>
                  {t('scriptAuthoringPage.tier.medium')}
                </option>
              </select>
              {effective.maxUnattendedRiskTier === 'low' && (
                <span className="mt-1 block text-xs text-muted-foreground" data-testid="script-max-risk-tier-reason">
                  {t('scriptAuthoringPage.aboveCeiling')}
                </span>
              )}
            </label>

            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                {t('scriptAuthoringPage.fields.allowedClasses')}
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {TOUCH_CLASSES.map((cls) => {
                  const hardDenied = LANE_HARD_DENIED_CLASSES.has(cls);
                  const aboveCeiling = !effective.unattendedAllowedClasses.includes(cls);
                  const checked = orgDraft.unattendedAllowedClasses.includes(cls);
                  const disabled = hardDenied || (!checked && aboveCeiling);
                  return (
                    <label key={cls} className="flex flex-col gap-0.5 text-sm">
                      <span className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          data-testid={`script-class-${cls}`}
                          checked={checked}
                          disabled={disabled}
                          onChange={() =>
                            setOrgDraft({
                              ...orgDraft,
                              unattendedAllowedClasses: checked
                                ? orgDraft.unattendedAllowedClasses.filter((c) => c !== cls)
                                : [...orgDraft.unattendedAllowedClasses, cls],
                            })
                          }
                        />
                        {t(/* i18n-dynamic */ CLASS_LABEL_KEYS[cls])}
                        {WINDOWS_ONLY_CLASSES.has(cls) && (
                          <span className="text-xs text-muted-foreground">({t('scriptAuthoringPage.windowsOnly')})</span>
                        )}
                      </span>
                      {hardDenied && (
                        <span className="text-xs text-muted-foreground" data-testid={`script-class-${cls}-reason`}>
                          {t('scriptAuthoringPage.hardDenied')}
                        </span>
                      )}
                      {!hardDenied && aboveCeiling && (
                        <span className="text-xs text-muted-foreground" data-testid={`script-class-${cls}-reason`}>
                          {t('scriptAuthoringPage.aboveCeiling')}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {numberField(
              'script-max-per-hour',
              t('scriptAuthoringPage.fields.perHour'),
              orgDraft.maxUnattendedPerHour,
              0,
              effective.maxUnattendedPerHour,
              (next) => setOrgDraft({ ...orgDraft, maxUnattendedPerHour: next }),
            )}

            <div className="block text-sm">
              <span className="font-medium">{t('scriptAuthoringPage.fields.reviewerModel')}</span>
              <div className="mt-1"><ModelDefaultsLink surface="script_reviewer" orgId={orgId} level="org" /></div>
            </div>

            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                {t('scriptAuthoringPage.fields.protectedResources')}
              </legend>
              <div className="grid gap-3 md:grid-cols-2">
                {listField('script-protected-services', t('scriptAuthoringPage.fields.protectedServices'), orgDraft.protectedResources.services, (v) => setOrgDraft({ ...orgDraft, protectedResources: { ...orgDraft.protectedResources, services: v } }))}
                {listField('script-protected-paths', t('scriptAuthoringPage.fields.protectedPaths'), orgDraft.protectedResources.paths, (v) => setOrgDraft({ ...orgDraft, protectedResources: { ...orgDraft.protectedResources, paths: v } }))}
                {listField('script-protected-registrykeys', t('scriptAuthoringPage.fields.protectedRegistryKeys'), orgDraft.protectedResources.registryKeys, (v) => setOrgDraft({ ...orgDraft, protectedResources: { ...orgDraft.protectedResources, registryKeys: v } }))}
                {listField('script-protected-devicetags', t('scriptAuthoringPage.fields.protectedDeviceTags'), orgDraft.protectedResources.deviceTags, (v) => setOrgDraft({ ...orgDraft, protectedResources: { ...orgDraft.protectedResources, deviceTags: v } }))}
              </div>
            </fieldset>

            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="script-authoring-save"
                onClick={() => void handleOrgSave()}
                disabled={orgSaving || resolvingReauth}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {orgSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t('scriptAuthoringPage.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Read-only summary rendered on the org card's neighbour when the partner
 *  row itself is unreadable (403 for an org-scoped token) — all we have then
 *  is the effective/ceiling projection off the org GET, not the partner's own
 *  protectedResources. */
function PartnerCeilingSummary({ effective, t }: { effective: EffectiveScriptPolicyDto; t: (key: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="space-y-2 text-sm" data-testid="script-partner-ceiling-summary">
      <p>
        {t('scriptAuthoringPage.fields.maxRiskTier')}: {t(/* i18n-dynamic */ effective.maxUnattendedRiskTier === 'medium' ? 'scriptAuthoringPage.tier.medium' : 'scriptAuthoringPage.tier.low')}
      </p>
      <p>{t('scriptAuthoringPage.fields.perHour')}: {effective.maxUnattendedPerHour}</p>
      <ul className="list-disc pl-5">
        {effective.unattendedAllowedClasses.map((cls) => (
          <li key={cls}>{t(/* i18n-dynamic */ CLASS_LABEL_KEYS[cls])}</li>
        ))}
      </ul>
    </div>
  );
}

function PartnerForm({
  draft,
  onChange,
  disabled,
  t,
}: {
  draft: PartnerDraft;
  onChange: (next: PartnerDraft) => void;
  disabled: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.proposingEnabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, proposingEnabled: e.target.checked })}
        />
        {t('scriptAuthoringPage.fields.proposingEnabled')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="script-partner-unattended-allowed"
          checked={draft.unattendedAllowed}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, unattendedAllowed: e.target.checked })}
        />
        {t('scriptAuthoringPage.fields.unattendedAllowed')}
      </label>
      <label className="block text-sm">
        <span className="font-medium">{t('scriptAuthoringPage.fields.maxRiskTier')}</span>
        <select
          value={draft.maxUnattendedRiskTier}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, maxUnattendedRiskTier: e.target.value as 'low' | 'medium' })}
          className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
        >
          <option value="low">{t('scriptAuthoringPage.tier.low')}</option>
          <option value="medium">{t('scriptAuthoringPage.tier.medium')}</option>
        </select>
      </label>
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('scriptAuthoringPage.fields.allowedClasses')}
        </legend>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {TOUCH_CLASSES.map((cls) => {
            const hardDenied = LANE_HARD_DENIED_CLASSES.has(cls);
            const checked = draft.unattendedAllowedClasses.includes(cls);
            return (
              <label key={cls} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid={`script-partner-class-${cls}`}
                  checked={checked}
                  disabled={disabled || hardDenied}
                  onChange={() =>
                    onChange({
                      ...draft,
                      unattendedAllowedClasses: checked
                        ? draft.unattendedAllowedClasses.filter((c) => c !== cls)
                        : [...draft.unattendedAllowedClasses, cls],
                    })
                  }
                />
                {t(/* i18n-dynamic */ CLASS_LABEL_KEYS[cls])}
              </label>
            );
          })}
        </div>
      </fieldset>
      {numberField('script-partner-max-per-hour', t('scriptAuthoringPage.fields.perHour'), draft.maxUnattendedPerHour, 0, 100, (next) => onChange({ ...draft, maxUnattendedPerHour: next }))}
      <div className="block text-sm">
        <span className="font-medium">{t('scriptAuthoringPage.fields.reviewerModel')}</span>
        <div className="mt-1"><ModelDefaultsLink surface="script_reviewer" level="partner" /></div>
      </div>
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('scriptAuthoringPage.fields.protectedResources')}
        </legend>
        <div className="grid gap-3 md:grid-cols-2">
          {listField('script-partner-protected-services', t('scriptAuthoringPage.fields.protectedServices'), draft.protectedResources.services, (v) => onChange({ ...draft, protectedResources: { ...draft.protectedResources, services: v } }))}
          {listField('script-partner-protected-paths', t('scriptAuthoringPage.fields.protectedPaths'), draft.protectedResources.paths, (v) => onChange({ ...draft, protectedResources: { ...draft.protectedResources, paths: v } }))}
          {listField('script-partner-protected-registrykeys', t('scriptAuthoringPage.fields.protectedRegistryKeys'), draft.protectedResources.registryKeys, (v) => onChange({ ...draft, protectedResources: { ...draft.protectedResources, registryKeys: v } }))}
          {listField('script-partner-protected-devicetags', t('scriptAuthoringPage.fields.protectedDeviceTags'), draft.protectedResources.deviceTags, (v) => onChange({ ...draft, protectedResources: { ...draft.protectedResources, deviceTags: v } }))}
        </div>
      </fieldset>
    </div>
  );
}
