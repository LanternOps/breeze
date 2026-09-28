import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Inbox } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllSites } from '@/lib/fetchAllSites';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import {
  canonicalParkedAssignResource,
  parkedAssignRequestBody,
  parkedBulkAssignRequestBody,
  type ParkedAssignResource,
} from '../../lib/parkedAssignResource';
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

/** The device-reported identity the dialog shows (all unverified). */
export interface ParkedDeviceSummary {
  id: string;
  hostname: string;
  osType: string;
  osVersion: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  primaryMacAddress: string | null;
}

export interface BulkItemResult {
  deviceId: string;
  ok: boolean;
  code?: string;
}

export interface AssignParkedDeviceDialogProps {
  open: boolean;
  /** One device = single assignment; more = one batch under one step-up grant. */
  devices: ParkedDeviceSummary[];
  passkeyCount?: number;
  mfaMethod?: string | null;
  onClose: () => void;
  onCompleted: () => void;
}

type Phase = 'form' | 'stepUp' | 'done';
interface SiteOption { id: string; name: string }

const ASSIGN_TARGET_STATUSES = new Set(['active', 'trial']);
const HIDDEN_TARGET_TYPES = new Set(['quick_support', 'unassigned_pool']);

/**
 * Assign parked devices to a customer org + site.
 *
 * Server-driven step-up, same contract as MoveDeviceOrgDialog: the first
 * submit carries no grant; a 403 STEP_UP_REQUIRED reveals the factor step, and
 * the grant is minted for exactly the device (or batch) and destination shown.
 */
export default function AssignParkedDeviceDialog({
  open,
  devices,
  passkeyCount,
  mfaMethod,
  onClose,
  onCompleted,
}: AssignParkedDeviceDialogProps) {
  const { t } = useTranslation('devices');
  const stableT = useStableT(t);
  const organizations = useOrgStore((s) => s.organizations);
  const fetchOrganizations = useOrgStore((s) => s.fetchOrganizations);
  const bulk = devices.length > 1;
  const single = devices[0];

  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = open;
    return () => { live.current = false; };
  }, [open]);

  const [targetOrgId, setTargetOrgId] = useState('');
  const [targetSiteId, setTargetSiteId] = useState('');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [possessionConfirmed, setPossessionConfirmed] = useState(false);
  const [collision, setCollision] = useState(false);
  const [acceptCollision, setAcceptCollision] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discoveredTier, setDiscoveredTier] = useState<ReauthTier | null>(null);
  const [results, setResults] = useState<BulkItemResult[] | null>(null);
  // A grant the server has not consumed yet: an identity-collision refusal
  // comes BEFORE the grant is spent, and the grant binds only the device and
  // destination (not acceptIdentityCollision), so the accept retry reuses it.
  const [heldGrant, setHeldGrant] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTargetOrgId('');
    setTargetSiteId('');
    setSites([]);
    setPossessionConfirmed(false);
    setCollision(false);
    setAcceptCollision(false);
    setPhase('form');
    setCode('');
    setError(null);
    setSubmitting(false);
    setDiscoveredTier(null);
    setResults(null);
    setHeldGrant(null);
  }, [open]);

  useEffect(() => {
    if (open && organizations.length === 0) void fetchOrganizations();
  }, [open, organizations.length, fetchOrganizations]);

  const targets = useMemo(
    () => organizations.filter((o) => ASSIGN_TARGET_STATUSES.has(o.status)
      && !HIDDEN_TARGET_TYPES.has((o as { type?: string }).type ?? '')),
    [organizations],
  );

  useEffect(() => {
    if (!open || !targetOrgId) { setSites([]); return; }
    let cancelled = false;
    setSitesLoading(true);
    setTargetSiteId('');
    fetchAllSites<SiteOption>(`/orgs/sites?organizationId=${targetOrgId}`)
      .then((list) => { if (!cancelled) setSites(list); })
      .catch(() => { if (!cancelled) { setSites([]); setError(stableT('assignParkedDialog.genericError')); } })
      .finally(() => { if (!cancelled) setSitesLoading(false); });
    return () => { cancelled = true; };
  }, [open, targetOrgId, stableT]);

  const tier: ReauthTier | null = useMemo(
    () => (passkeyCount === undefined || mfaMethod === undefined ? discoveredTier : pickReauthTier(passkeyCount, mfaMethod)),
    [passkeyCount, mfaMethod, discoveredTier],
  );
  const noUsableFactor = phase === 'stepUp' && tier === 'password';

  const discoverTier = useCallback(async (): Promise<boolean> => {
    if (tier !== null) return true;
    try {
      const [userResponse, passkeyResponse] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
      if (!userResponse.ok || !passkeyResponse.ok) throw new Error();
      const user = await userResponse.json();
      const passkeyData = await passkeyResponse.json();
      const passkeys = Array.isArray(passkeyData) ? passkeyData : passkeyData?.passkeys;
      if (!user || typeof user !== 'object' || !('mfaMethod' in user) || !Array.isArray(passkeys)) throw new Error();
      setDiscoveredTier(pickReauthTier(passkeys.length, user.mfaMethod));
      return true;
    } catch {
      setError(t('assignParkedDialog.genericError'));
      return false;
    }
  }, [tier, t]);

  const submit = useCallback(async () => {
    // ONE canonical object per device for both the mint and the body.
    const resources: ParkedAssignResource[] = devices.map((d) =>
      canonicalParkedAssignResource({ deviceId: d.id, targetOrgId, targetSiteId }));

    let stepUpGrant: string | undefined;
    const reusedGrant = phase === 'form' && heldGrant !== null;
    if (reusedGrant) {
      stepUpGrant = heldGrant!;
      setHeldGrant(null);
    } else if (phase === 'stepUp') {
      try {
        stepUpGrant = await mintStepUpGrant({
          operation: bulk ? 'parked_device_assign_bulk' : 'parked_device_assign',
          resource: bulk ? { items: resources } : resources[0],
          reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
      } catch (err) {
        setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('assignParkedDialog.genericError'));
        return;
      }
    }
    if (!live.current) return;

    const orgName = targets.find((o) => o.id === targetOrgId)?.name ?? '';
    try {
      if (bulk) {
        const data = await runAction<{ results: BulkItemResult[] }>({
          request: () => fetchWithAuth('/pre-assignment/devices/assign-bulk', {
            method: 'POST',
            body: JSON.stringify(parkedBulkAssignRequestBody(resources, stepUpGrant)),
          }),
          errorFallback: t('assignParkedDialog.genericError'),
          friendly: (c) => (c === 'STEP_UP_REQUIRED' ? t('assignParkedDialog.stepUpIntro') : undefined),
          successMessage: (d) => t('assignParkedDialog.bulkSummary', {
            ok: d.results.filter((r) => r.ok).length,
            total: d.results.length,
          }),
        });
        setResults(data.results);
        setPhase('done');
        onCompleted();
        return;
      }
      await runAction({
        request: () => fetchWithAuth(`/pre-assignment/devices/${resources[0]!.deviceId}/assign`, {
          method: 'POST',
          body: JSON.stringify(parkedAssignRequestBody(resources[0]!, { stepUpGrant, acceptIdentityCollision: acceptCollision })),
        }),
        errorFallback: t('assignParkedDialog.genericError'),
        friendly: (c) => (c === 'STEP_UP_REQUIRED' ? t('assignParkedDialog.stepUpIntro') : undefined),
        successMessage: t('assignParkedDialog.successSingle', { hostname: single?.hostname ?? '', orgName }),
      });
      onCompleted();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('assignParkedDialog.genericError') });
        return;
      }
      if (err.status === 403 && err.code === 'STEP_UP_REQUIRED') {
        // A held grant can expire between the refusal and the retry: ask for
        // a fresh proof exactly as for a first submit.
        if (stepUpGrant && !reusedGrant) {
          setCode('');
          setError(t('assignParkedDialog.stepUpRetry'));
          return;
        }
        if (!(await discoverTier())) return;
        setPhase('stepUp');
        setCode('');
        setError(null);
        return;
      }
      if (err.status === 409 && err.code === 'DEVICE_IDENTITY_COLLISION') {
        // Accepting changes nothing in the grant binding, but the grant (if
        // any) was not consumed: the refusal came before it. Back to the form.
        setCollision(true);
        if (stepUpGrant) setHeldGrant(stepUpGrant);
        setPhase('form');
        setCode('');
        setError(null);
        return;
      }
      setError(err.message);
    }
  }, [devices, targetOrgId, targetSiteId, phase, heldGrant, bulk, tier, code, targets, acceptCollision, single, onCompleted, onClose, discoverTier, t]);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    void submit().finally(() => setSubmitting(false));
  }, [submit, submitting]);

  const title = bulk
    ? t('assignParkedDialog.titleBulk', { count: devices.length })
    : t('assignParkedDialog.titleSingle', { hostname: single?.hostname ?? '' });
  const destinationChosen = targetOrgId !== '' && targetSiteId !== '';
  const collisionGate = collision && !acceptCollision;
  const canSubmit = destinationChosen && possessionConfirmed && !submitting && !collisionGate
    && (phase === 'form' || tier === 'passkey' || code.length === 6);
  const hostnameFor = (id: string) => devices.find((d) => d.id === id)?.hostname ?? id;

  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="lg" className="p-6">
      <div className="flex gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('assignParkedDialog.description')}</p>
        </div>
      </div>

      <div className="mt-4 rounded-md border bg-muted/30 p-3" data-testid="assign-parked-identity">
        <p className="text-xs font-medium text-warning" data-testid="assign-parked-identity-caption">
          {t('assignParkedDialog.identityCaption')}
        </p>
        {bulk ? (
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap gap-x-3">
                <span className="font-medium">{d.hostname}</span>
                <span className="text-muted-foreground">{d.serialNumber ?? '—'}</span>
                <span className="text-muted-foreground">{d.primaryMacAddress ?? '—'}</span>
              </li>
            ))}
          </ul>
        ) : single ? (
          <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('assignParkedDialog.hostnameLabel')}</dt>
            <dd className="break-all">{single.hostname}</dd>
            <dt className="text-muted-foreground">{t('assignParkedDialog.osLabel')}</dt>
            <dd>{`${single.osType} ${single.osVersion}`}</dd>
            <dt className="text-muted-foreground">{t('assignParkedDialog.serialLabel')}</dt>
            <dd className="break-all">{single.serialNumber ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('assignParkedDialog.macLabel')}</dt>
            <dd className="break-all">{single.primaryMacAddress ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('assignParkedDialog.modelLabel')}</dt>
            <dd>{[single.manufacturer, single.model].filter(Boolean).join(' ') || '—'}</dd>
          </dl>
        ) : null}
      </div>

      {phase === 'done' && results ? (
        <ul className="mt-4 space-y-1 text-sm" data-testid="assign-parked-results">
          {results.map((r) => (
            <li key={r.deviceId} data-testid={`assign-parked-result-${r.deviceId}`} className="flex justify-between gap-3">
              <span className="font-medium">{hostnameFor(r.deviceId)}</span>
              <span className={r.ok ? 'text-success' : 'text-destructive'}>
                {r.ok
                  ? t('assignParkedDialog.resultOk')
                  : t(/* i18n-dynamic */ `assignParkedDialog.resultCodes.${r.code ?? 'ASSIGNMENT_FAILED'}`, {
                    defaultValue: t('assignParkedDialog.resultCodes.ASSIGNMENT_FAILED'),
                  })}
              </span>
            </li>
          ))}
        </ul>
      ) : noUsableFactor ? (
        <p className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="assign-parked-no-factor">
          {t('assignParkedDialog.noStepUpFactor')}
        </p>
      ) : targets.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="assign-parked-no-orgs">{t('assignParkedDialog.noOrgs')}</p>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="assign-parked-target-org">{t('assignParkedDialog.targetOrgLabel')}</label>
            <select
              id="assign-parked-target-org"
              data-testid="assign-parked-target-org"
              value={targetOrgId}
              onChange={(e) => { setTargetOrgId(e.target.value); setCollision(false); setAcceptCollision(false); setHeldGrant(null); setError(null); }}
              disabled={submitting || phase === 'stepUp'}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('assignParkedDialog.targetOrgPlaceholder')}</option>
              {targets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>

          {targetOrgId !== '' && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="assign-parked-target-site">{t('assignParkedDialog.targetSiteLabel')}</label>
              {sitesLoading ? (
                <p className="text-xs text-muted-foreground">{t('assignParkedDialog.loadingSites')}</p>
              ) : sites.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="assign-parked-no-sites">{t('assignParkedDialog.noSites')}</p>
              ) : (
                <select
                  id="assign-parked-target-site"
                  data-testid="assign-parked-target-site"
                  value={targetSiteId}
                  onChange={(e) => { setTargetSiteId(e.target.value); setCollision(false); setAcceptCollision(false); setHeldGrant(null); }}
                  disabled={submitting || phase === 'stepUp'}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">{t('assignParkedDialog.targetSitePlaceholder')}</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="assign-parked-possession"
              checked={possessionConfirmed}
              onChange={(e) => setPossessionConfirmed(e.target.checked)}
              disabled={submitting || phase === 'stepUp'}
              className="mt-0.5"
            />
            <span>{t('assignParkedDialog.possession')}</span>
          </label>

          {collision && !bulk && (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" data-testid="assign-parked-collision">
              <p className="text-sm font-medium">{t('assignParkedDialog.collisionHeading')}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="assign-parked-accept-collision"
                  checked={acceptCollision}
                  onChange={(e) => setAcceptCollision(e.target.checked)}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span>{t('assignParkedDialog.collisionAccept')}</span>
              </label>
            </div>
          )}

          {phase === 'stepUp' && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t('assignParkedDialog.stepUpHeading')}</p>
              <p className="text-xs text-muted-foreground">{t('assignParkedDialog.stepUpIntro')}</p>
              {tier === 'passkey' ? (
                <p className="text-xs text-muted-foreground" data-testid="assign-parked-stepup-passkey">{t('assignParkedDialog.stepUpPasskeyNote')}</p>
              ) : (
                <>
                  <label className="text-sm font-medium" htmlFor="assign-parked-stepup-code">{t('assignParkedDialog.stepUpCodeLabel')}</label>
                  <input
                    id="assign-parked-stepup-code"
                    data-testid="assign-parked-stepup-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    disabled={submitting}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error != null && (
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="assign-parked-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          data-testid="assign-parked-cancel"
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {phase === 'done' ? t('assignParkedDialog.close') : t('assignParkedDialog.cancel')}
        </button>
        {phase !== 'done' && !noUsableFactor && targets.length > 0 && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="assign-parked-submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting
              ? t('assignParkedDialog.submitting')
              : phase === 'stepUp'
                ? t('assignParkedDialog.submitStepUp')
                : t('assignParkedDialog.submit')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
