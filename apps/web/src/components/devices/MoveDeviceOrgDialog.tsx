import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { usePermissions } from '@/lib/permissions';
import { canonicalMoveOrgResource, moveOrgRequestBody } from '../../lib/moveOrgResource';
import { moveDeviceOrg } from '../../services/deviceActions';
import '../../lib/i18n';

export interface MoveDeviceOrgDialogProps {
  open: boolean;
  device: { id: string; hostname: string; orgId: string; orgName: string };
  /**
   * The account's step-up factors, when the caller knows them. BOTH must be
   * supplied for the tier to be decidable; otherwise the dialog discovers them
   * only after the server asks for step-up (same contract as
   * MaintenanceModeDialog).
   */
  passkeyCount?: number;
  mfaMethod?: string | null;
  onClose: () => void;
  onCompleted: (result: { targetOrgId: string; targetOrgName: string }) => void;
}

type Phase = 'form' | 'stepUp';

interface SiteOption { id: string; name: string }

interface CurrencyBlock {
  sourceCurrency: string;
  targetCurrency: string;
  unbilledTimeEntries: number;
  unbilledParts: number;
}

/** Orgs a device can be moved INTO: any other org of the partner that is live. */
const MOVE_TARGET_STATUSES = new Set(['active', 'trial']);

/**
 * Move a device to another organization — spec 2026-09-18 device-move-org D5.
 *
 * SERVER-DRIVEN STEP-UP: the first submit carries NO grant. A
 * `403 { code: 'STEP_UP_REQUIRED' }` is what reveals the factor step. The web
 * never reads ENABLE_2FA, so a 2FA-off deployment succeeds on the first
 * submit and the server stays the only enforcer.
 */
export default function MoveDeviceOrgDialog({
  open,
  device,
  passkeyCount,
  mfaMethod,
  onClose,
  onCompleted,
}: MoveDeviceOrgDialogProps) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  const organizations = useOrgStore((s) => s.organizations);
  const fetchOrganizations = useOrgStore((s) => s.fetchOrganizations);

  // Invalidate at unmount commit so a pending proof cannot resume a dispatch.
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = open;
    return () => { live.current = false; };
  }, [open]);

  const [targetOrgId, setTargetOrgId] = useState('');
  const [targetSiteId, setTargetSiteId] = useState('');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [acceptCurrencyMismatch, setAcceptCurrencyMismatch] = useState(false);
  const [currencyBlock, setCurrencyBlock] = useState<CurrencyBlock | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discoveredTier, setDiscoveredTier] = useState<ReauthTier | null>(null);

  // Reset on (re)open: a stale target would otherwise be minted into a grant
  // for the wrong move.
  useEffect(() => {
    if (!open) return;
    setTargetOrgId('');
    setTargetSiteId('');
    setSites([]);
    setAcceptCurrencyMismatch(false);
    setCurrencyBlock(null);
    setPhase('form');
    setCode('');
    setError(null);
    setSubmitting(false);
    setDiscoveredTier(null);
  }, [open]);

  // Separate from the reset above: an org-store refresh while the dialog is
  // open must not wipe an in-progress step-up.
  useEffect(() => {
    if (open && organizations.length === 0) void fetchOrganizations();
  }, [open, organizations.length, fetchOrganizations]);

  const targets = useMemo(
    () => organizations.filter((o) => o.id !== device.orgId && MOVE_TARGET_STATUSES.has(o.status)),
    [organizations, device.orgId],
  );

  // Load the chosen org's sites. The route requires the target site to belong
  // to the target org, so the picker only offers those.
  useEffect(() => {
    if (!open || !targetOrgId) { setSites([]); return; }
    let cancelled = false;
    setSitesLoading(true);
    setTargetSiteId('');
    fetchWithAuth(`/orgs/sites?organizationId=${targetOrgId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('sites'))))
      .then((data) => {
        if (cancelled) return;
        const list: SiteOption[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
        setSites(list);
      })
      .catch(() => { if (!cancelled) { setSites([]); setError(t('moveDeviceOrgDialog.genericError')); } })
      .finally(() => { if (!cancelled) setSitesLoading(false); });
    return () => { cancelled = true; };
  }, [open, targetOrgId, t]);

  const tier: ReauthTier | null = useMemo(
    () =>
      passkeyCount === undefined || mfaMethod === undefined
        ? discoveredTier
        : pickReauthTier(passkeyCount, mfaMethod),
    [passkeyCount, mfaMethod, discoveredTier],
  );
  // `password` is not a valid step-up method for device_move_org and there is
  // no authenticated step-up SMS sender, so a submit could only ever 403.
  const noUsableFactor = phase === 'stepUp' && tier === 'password';
  const canAcceptCurrency = can('invoices', 'write');

  const submit = useCallback(async () => {
    // ONE canonical object for both the mint and the body (see lib/moveOrgResource.ts).
    const resource = canonicalMoveOrgResource({
      deviceId: device.id,
      targetOrgId,
      targetSiteId,
      acceptCurrencyMismatch,
    });

    let stepUpGrant: string | undefined;
    if (phase === 'stepUp') {
      try {
        stepUpGrant = await mintStepUpGrant({
          operation: 'device_move_org',
          resource,
          reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
      } catch (err) {
        setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('moveDeviceOrgDialog.genericError'));
        return;
      }
    }

    if (!live.current) return;

    try {
      await moveDeviceOrg(device.id, moveOrgRequestBody(resource, stepUpGrant));
      const targetOrgName = targets.find((o) => o.id === targetOrgId)?.name ?? '';
      onCompleted({ targetOrgId, targetOrgName });
      onClose();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      const errCode = (err as { code?: string } | null)?.code;
      if (status === 403 && errCode === 'STEP_UP_REQUIRED') {
        if (stepUpGrant) {
          // The route answers a spent, raced or epoch-invalidated grant with the
          // same 403 as a missing one. We are already on the factor step, so
          // say the proof was refused rather than just emptying the code box.
          setCode('');
          setError(t('moveDeviceOrgDialog.stepUpRetry'));
          return;
        }
        if (tier === null) {
          try {
            const [userResponse, passkeyResponse] = await Promise.all([
              fetchWithAuth('/users/me'),
              fetchWithAuth('/auth/passkeys'),
            ]);
            if (!userResponse.ok || !passkeyResponse.ok) throw new Error();
            const user = await userResponse.json();
            const passkeyData = await passkeyResponse.json();
            const passkeys = Array.isArray(passkeyData) ? passkeyData : passkeyData?.passkeys;
            if (!user || typeof user !== 'object' || !('mfaMethod' in user) || !Array.isArray(passkeys)) {
              throw new Error();
            }
            setDiscoveredTier(pickReauthTier(passkeys.length, user.mfaMethod));
          } catch {
            setError(t('moveDeviceOrgDialog.genericError'));
            return;
          }
        }
        // The SERVER decided a factor is needed. Only now does the step appear.
        setPhase('stepUp');
        setCode('');
        setError(null);
        return;
      }
      if (status === 403 && errCode === 'MFA_REQUIRED') {
        // A step-up factor cannot substitute for a full MFA sign-in, so do NOT
        // reveal the factor step here.
        setError(t('moveDeviceOrgDialog.mfaRequired'));
        return;
      }
      if (status === 409 && errCode === 'TICKET_MOVE_CURRENCY_BLOCKED') {
        const d = (err as { details?: Partial<CurrencyBlock> } | null)?.details ?? {};
        setCurrencyBlock({
          sourceCurrency: String(d.sourceCurrency ?? ''),
          targetCurrency: String(d.targetCurrency ?? ''),
          unbilledTimeEntries: Number(d.unbilledTimeEntries ?? 0),
          unbilledParts: Number(d.unbilledParts ?? 0),
        });
        // With 2FA on the server consumes the grant BEFORE its in-transaction
        // currency guard (routes/devices/moveOrg.ts), so this 409 normally
        // arrives while we are in the step-up phase, with the grant burned.
        // Accepting changes the digest and needs a NEW grant, so go back to
        // the form: the next submit carries no grant and the server asks for
        // step-up again against the accepted resource.
        setPhase('form');
        setCode('');
        setError(null);
        return;
      }
      setError((err as { message?: string } | null)?.message ?? t('moveDeviceOrgDialog.genericError'));
    }
  }, [device.id, targetOrgId, targetSiteId, acceptCurrencyMismatch, phase, tier, code, targets, onCompleted, onClose, t]);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    void submit().finally(() => setSubmitting(false));
  }, [submit, submitting]);

  const title = t('moveDeviceOrgDialog.title');
  const targetChosen = targetOrgId !== '' && targetSiteId !== '';
  const currencyGate = currencyBlock !== null && !acceptCurrencyMismatch;
  const canSubmit =
    targetChosen && !submitting && !currencyGate &&
    (phase === 'form' || tier === 'passkey' || code.length === 6);

  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="lg" className="p-6">
      <div className="flex gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10">
          <ArrowRightLeft className="h-5 w-5 text-warning" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('moveDeviceOrgDialog.description', { hostname: device.hostname, orgName: device.orgName })}
          </p>
        </div>
      </div>

      {noUsableFactor ? (
        <p
          className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          data-testid="move-org-no-factor"
        >
          {t('moveDeviceOrgDialog.noStepUpFactor')}
        </p>
      ) : targets.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="move-org-no-targets">
          {t('moveDeviceOrgDialog.noOtherOrgs')}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="move-org-target-org">
              {t('moveDeviceOrgDialog.targetOrgLabel')}
            </label>
            <select
              id="move-org-target-org"
              data-testid="move-org-target-org"
              value={targetOrgId}
              onChange={(e) => { setTargetOrgId(e.target.value); setCurrencyBlock(null); setAcceptCurrencyMismatch(false); setError(null); }}
              disabled={submitting || phase === 'stepUp'}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('moveDeviceOrgDialog.targetOrgPlaceholder')}</option>
              {targets.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>

          {targetOrgId !== '' && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="move-org-target-site">
                {t('moveDeviceOrgDialog.targetSiteLabel')}
              </label>
              {sitesLoading ? (
                <p className="text-xs text-muted-foreground">{t('moveDeviceOrgDialog.loadingSites')}</p>
              ) : sites.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="move-org-no-sites">
                  {t('moveDeviceOrgDialog.noSites')}
                </p>
              ) : (
                <select
                  id="move-org-target-site"
                  data-testid="move-org-target-site"
                  value={targetSiteId}
                  onChange={(e) => setTargetSiteId(e.target.value)}
                  disabled={submitting || phase === 'stepUp'}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">{t('moveDeviceOrgDialog.targetSitePlaceholder')}</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {currencyBlock && (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" data-testid="move-org-currency-block">
              <p className="text-sm font-medium">{t('moveDeviceOrgDialog.currencyMismatchHeading')}</p>
              <p className="text-xs text-muted-foreground">
                {t('moveDeviceOrgDialog.currencyMismatchDetail', {
                  sourceCurrency: currencyBlock.sourceCurrency,
                  targetCurrency: currencyBlock.targetCurrency,
                  timeEntries: currencyBlock.unbilledTimeEntries,
                  parts: currencyBlock.unbilledParts,
                })}
              </p>
              {canAcceptCurrency ? (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="move-org-currency-accept"
                    checked={acceptCurrencyMismatch}
                    onChange={(e) => setAcceptCurrencyMismatch(e.target.checked)}
                    disabled={submitting || phase === 'stepUp'}
                    className="mt-0.5"
                  />
                  <span>{t('moveDeviceOrgDialog.currencyMismatchAccept')}</span>
                </label>
              ) : (
                <p className="text-xs text-foreground">{t('moveDeviceOrgDialog.currencyMismatchNoPermission')}</p>
              )}
            </div>
          )}

          {phase === 'stepUp' && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t('moveDeviceOrgDialog.stepUpHeading')}</p>
              <p className="text-xs text-muted-foreground">{t('moveDeviceOrgDialog.stepUpIntro')}</p>
              {tier === 'passkey' ? (
                <p className="text-xs text-muted-foreground" data-testid="move-org-stepup-passkey">
                  {t('moveDeviceOrgDialog.stepUpPasskeyNote')}
                </p>
              ) : (
                <>
                  <label className="text-sm font-medium" htmlFor="move-org-stepup-code">
                    {t('moveDeviceOrgDialog.stepUpCodeLabel')}
                  </label>
                  <input
                    id="move-org-stepup-code"
                    data-testid="move-org-stepup-code"
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
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="move-org-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {t('moveDeviceOrgDialog.cancel')}
        </button>
        {!noUsableFactor && targets.length > 0 && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="move-org-submit"
            className="rounded-md bg-warning px-4 py-2 text-sm font-medium text-warning-foreground hover:bg-warning/90 transition-colors disabled:opacity-50"
          >
            {submitting
              ? t('moveDeviceOrgDialog.submitting')
              : phase === 'stepUp'
                ? t('moveDeviceOrgDialog.submitStepUp')
                : t('moveDeviceOrgDialog.submit')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
