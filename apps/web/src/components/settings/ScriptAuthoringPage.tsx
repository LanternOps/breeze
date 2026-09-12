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
import { LANE_HARD_DENIED_CLASSES, TOUCH_CLASSES } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgScope } from '@/hooks/useOrgScope';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { mintStepUpGrant, StepUpMintError, type StepUpReauth } from '../../lib/mfaStepUp';
import StepUpPrompt, { pickReauthTier, type ReauthTier } from './StepUpPrompt';
import { listField, numberField } from './aiAgents/agentFields';

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
  reviewerModel: string;
  protectedResources: ProtectedResourcesDraft;
}

interface PartnerDraft {
  proposingEnabled: boolean;
  unattendedAllowed: boolean;
  maxUnattendedRiskTier: 'low' | 'medium';
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  reviewerModel: string;
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
    reviewerModel: policy?.reviewerModel ?? '',
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
    reviewerModel: policy?.reviewerModel ?? '',
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

  const [partnerPolicy, setPartnerPolicy] = useState<ScriptPolicyDto | null>(null);
  const [partnerCanManage, setPartnerCanManage] = useState(false);
  const [partnerFetchFailed, setPartnerFetchFailed] = useState(false);
  const [partnerDraft, setPartnerDraft] = useState<PartnerDraft | null>(null);
  const [partnerSaving, setPartnerSaving] = useState(false);

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
        setError(t('scriptAuthoringPage.loadFailed'));
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
        setPartnerDraft(partnerDraftFromPolicy(body.policy));
      } else {
        setPartnerFetchFailed(true);
        setPartnerCanManage(false);
        setPartnerPolicy(null);
        setPartnerDraft(null);
      }
    } catch {
      setError(t('scriptAuthoringPage.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [orgId, orgScope.scope, t]);

  useEffect(() => {
    void load();
    // `load` is itself memoized on [orgId, orgScope.scope, t], so depending on
    // it alone re-runs exactly when either input actually changes.
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

  const mintLaneGrant = useCallback(async (resource: Record<string, unknown>): Promise<string> => {
    const tier = await ensureReauthTier();
    if (!tier || tier === 'password') {
      throw new StepUpMintError('unavailable', t('scriptAuthoringPage.stepUp.body'));
    }
    const reauth: StepUpReauth = tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code: reauthCode };
    return mintStepUpGrant({ operation: 'ai_script_lane_grant', resource, reauth });
  }, [ensureReauthTier, reauthCode, t]);

  const handleOrgSave = useCallback(async () => {
    if (!orgDraft || !orgId) return;
    setOrgSaving(true);
    setError(null);
    const wasEnabled = orgPolicy?.unattendedEnabled ?? false;
    const isEnabling = orgDraft.unattendedEnabled && !wasEnabled;
    try {
      let stepUpGrant: string | undefined;
      if (isEnabling) {
        try {
          stepUpGrant = await mintLaneGrant({ orgId, unattendedEnabled: true });
        } catch (err) {
          setError(err instanceof Error ? err.message : t('scriptAuthoringPage.saveFailed'));
          return;
        }
      }
      const body: Record<string, unknown> = {
        proposingEnabled: orgDraft.proposingEnabled,
        unattendedEnabled: orgDraft.unattendedEnabled,
        maxUnattendedRiskTier: orgDraft.maxUnattendedRiskTier,
        unattendedAllowedClasses: orgDraft.unattendedAllowedClasses,
        maxUnattendedPerHour: orgDraft.maxUnattendedPerHour,
        reviewerModel: orgDraft.reviewerModel.trim() ? orgDraft.reviewerModel.trim() : null,
        protectedResources: {
          services: fromLines(orgDraft.protectedResources.services),
          paths: fromLines(orgDraft.protectedResources.paths),
          registryKeys: fromLines(orgDraft.protectedResources.registryKeys),
          deviceTags: fromLines(orgDraft.protectedResources.deviceTags),
        },
        ...(stepUpGrant ? { stepUpGrant } : {}),
      };
      const result = await runAction<OrgGetResponse | { policy: ScriptPolicyDto }>({
        request: () => fetchWithAuth('/ai/script-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        errorFallback: t('scriptAuthoringPage.saveFailed'),
        successMessage: t('scriptAuthoringPage.saved'),
      });
      setReauthCode('');
      if ('policy' in result && result.policy) setOrgPolicy(result.policy);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ message: t('scriptAuthoringPage.saveFailed'), type: 'error' });
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.saveFailed'));
    } finally {
      setOrgSaving(false);
    }
  }, [orgDraft, orgId, orgPolicy, mintLaneGrant, load, t]);

  const handlePartnerSave = useCallback(async () => {
    if (!partnerDraft) return;
    setPartnerSaving(true);
    setError(null);
    try {
      const body = {
        proposingEnabled: partnerDraft.proposingEnabled,
        unattendedAllowed: partnerDraft.unattendedAllowed,
        maxUnattendedRiskTier: partnerDraft.maxUnattendedRiskTier,
        unattendedAllowedClasses: partnerDraft.unattendedAllowedClasses,
        maxUnattendedPerHour: partnerDraft.maxUnattendedPerHour,
        reviewerModel: partnerDraft.reviewerModel.trim() ? partnerDraft.reviewerModel.trim() : null,
        protectedResources: {
          services: fromLines(partnerDraft.protectedResources.services),
          paths: fromLines(partnerDraft.protectedResources.paths),
          registryKeys: fromLines(partnerDraft.protectedResources.registryKeys),
          deviceTags: fromLines(partnerDraft.protectedResources.deviceTags),
        },
      };
      await runAction({
        request: () => fetchWithAuth('/partner/ai/script-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        errorFallback: t('scriptAuthoringPage.saveFailed'),
        successMessage: t('scriptAuthoringPage.saved'),
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ message: t('scriptAuthoringPage.saveFailed'), type: 'error' });
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.saveFailed'));
    } finally {
      setPartnerSaving(false);
    }
  }, [partnerDraft, load, t]);

  const handleReset = useCallback(async () => {
    if (!orgId) return;
    setResetting(true);
    setError(null);
    try {
      let stepUpGrant: string;
      try {
        stepUpGrant = await mintLaneGrant({ orgId, unattendedEnabled: true, reset: true });
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
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ message: t('scriptAuthoringPage.lane.resetFailed'), type: 'error' });
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.lane.resetFailed'));
    } finally {
      setResetting(false);
    }
  }, [orgId, mintLaneGrant, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const showTotpBox = orgDraft?.unattendedEnabled && !(orgPolicy?.unattendedEnabled ?? false) && reauthTier === 'totp';
  const showPasskeyNote = orgDraft?.unattendedEnabled && !(orgPolicy?.unattendedEnabled ?? false) && reauthTier === 'passkey';

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
              <button
                type="button"
                data-testid="script-lane-reset"
                onClick={() => void handleReset()}
                disabled={resetting || !orgId}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
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

        {partnerCanManage && partnerDraft && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="script-partner-save"
              onClick={() => void handlePartnerSave()}
              disabled={partnerSaving}
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
            {(showTotpBox || showPasskeyNote) && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">{t('scriptAuthoringPage.stepUp.title')}</p>
                <p className="text-xs text-muted-foreground">{t('scriptAuthoringPage.stepUp.body')}</p>
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

            <label className="block text-sm">
              <span className="font-medium">{t('scriptAuthoringPage.fields.reviewerModel')}</span>
              <input
                type="text"
                data-testid="script-reviewer-model"
                value={orgDraft.reviewerModel}
                onChange={(e) => setOrgDraft({ ...orgDraft, reviewerModel: e.target.value })}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              />
              <span className="mt-1 block text-xs text-muted-foreground">{t('scriptAuthoringPage.fields.reviewerModelHint')}</span>
            </label>

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
 *  protectedResources or reviewerModel. */
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
      <label className="block text-sm">
        <span className="font-medium">{t('scriptAuthoringPage.fields.reviewerModel')}</span>
        <input
          type="text"
          value={draft.reviewerModel}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, reviewerModel: e.target.value })}
          className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
        />
      </label>
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
