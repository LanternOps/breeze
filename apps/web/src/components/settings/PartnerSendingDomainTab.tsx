import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PartnerMailStreamValue,
  SendingDomainDto,
  SendingDomainsListResponse,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { handleActionError } from '../../lib/runAction';
import { dispatchTrustDenied } from '../../lib/trustProbation';
import { showToast } from '../shared/Toast';
import {
  createSendingDomain,
  deleteSenderIdentity,
  fetchSendingDomains,
  removeSendingDomain,
  requestSendingDomainCheck,
  sendSendingDomainTest,
  upsertSenderIdentity,
} from '../../lib/api/sendingDomains';
import AddDomainForm from './sendingDomains/AddDomainForm';
import DomainStatusPanel from './sendingDomains/DomainStatusPanel';
import SenderIdentitiesForm from './sendingDomains/SenderIdentitiesForm';
import TestSendControl from './sendingDomains/TestSendControl';
import { isTabVisible, isTrustLock, lockedCopySuffix, pollIntervalMs } from './sendingDomains/domainView';
import '@/lib/i18n';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface InboundState {
  configured: boolean;
  address: string | null;
}

/**
 * Custom sender addresses (spec §10). Self-saving: every control persists
 * itself, so the Partner Settings page's global Save button does not apply.
 *
 * The tab owns the only state in this feature — the list, the poll timer and a
 * single `busy` flag — and hands plain data to the presentational children.
 * Polling follows spec §10: 2 s while provisioning, 15 s while waiting for DNS
 * (or while a removal or test send is in flight), nothing once everything has
 * settled. It stops on unmount and while the browser tab is hidden, so a
 * forgotten tab never holds a 2-second loop open.
 */
export default function PartnerSendingDomainTab() {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<SendingDomainsListResponse | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [inbound, setInbound] = useState<InboundState>({ configured: false, address: null });

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const result = await fetchSendingDomains();
      setNowMs(Date.now());
      if (!result.supported) {
        setUnsupported(true);
        setData(null);
      } else {
        setUnsupported(false);
        setData(result.data);
      }
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    // Best-effort: the inbound address decides which "where replies go" copy the
    // support stream gets (spec §8.5). A failure just means the conservative
    // no-inbound wording, never a broken tab.
    fetchWithAuth('/ticket-config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ticket config unavailable'))))
      .then((body: { data?: { inbound?: { domainConfigured?: boolean; address?: string | null } } }) => {
        const cfg = body.data?.inbound;
        setInbound({ configured: cfg?.domainConfigured === true, address: cfg?.address ?? null });
      })
      .catch(() => setInbound({ configured: false, address: null }));
  }, [load]);

  // One timer per data version. `load` replaces `data`, which re-runs this
  // effect and re-arms — so there is never more than one timer in flight.
  useEffect(() => {
    if (!data) return;
    const interval = pollIntervalMs(data.domains);
    if (interval === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
      if (cancelled || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (cancelled || document.visibilityState === 'hidden') return;
        void load(false);
      }, interval);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') arm();
    };

    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [data, load]);

  const maxDomains = data?.capability.maxDomains ?? 0;

  const run = useCallback(
    async (action: () => Promise<unknown>, fallbackKey: string) => {
      setBusy(true);
      try {
        await action();
        await load(false);
      } catch (err) {
        // 401 is the auth redirect's business; a non-ActionError has not been
        // toasted yet; an ActionError already has (lib/runAction.ts:196).
        handleActionError(err, t(/* i18n-dynamic */ `partnerSendingDomains.${fallbackKey}`));
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  const handleAdd = (domain: string) =>
    run(() => createSendingDomain({ domain, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorAddFailed');

  const handleCheck = (domainId: string) =>
    run(() => requestSendingDomainCheck({ domainId, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorCheckFailed');

  const handleRemove = (domain: SendingDomainDto) => {
    const message = domain.providerManaged
      ? t('partnerSendingDomains.removeConfirm', { domain: domain.domain })
      : t('partnerSendingDomains.removeConfirmUnmanaged', { domain: domain.domain });
    if (!window.confirm(message)) return Promise.resolve();
    return run(
      () => removeSendingDomain({ domainId: domain.id, maxDomains, onUnauthorized: UNAUTHORIZED }),
      'errorRemoveFailed',
    );
  };

  const handleSaveIdentity = (input: {
    stream: PartnerMailStreamValue; sendingDomainId: string;
    localPart: string; displayName: string | null; replyTo: string | null;
  }) => run(() => upsertSenderIdentity({ ...input, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorIdentityFailed');

  const handleClearIdentity = (stream: PartnerMailStreamValue) =>
    run(() => deleteSenderIdentity({ stream, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorIdentityFailed');

  const handleTest = (domainId: string) =>
    run(() => sendSendingDomainTest({ domainId, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorTestFailed');

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sending-domains-loading">
        {t('common:states.loading')}
      </p>
    );
  }

  if (loadFailed) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sending-domains-error">
        {t('partnerSendingDomains.loadFailed')}{' '}
        <button
          type="button"
          onClick={() => void load(true)}
          className="underline hover:text-foreground"
          data-testid="sending-domains-retry"
        >
          {t('common:actions.retry')}
        </button>
      </p>
    );
  }

  // Defensive: the page already hides the tab when the instance has no provider.
  if (unsupported || !data || !isTabVisible(data.capability)) return null;

  const { capability, domains, identities } = data;
  const trustLock = isTrustLock(capability);

  const showVerification = () => {
    const handled = dispatchTrustDenied({
      error: capability.reason === 'restricted' ? 'TRUST_RESTRICTED' : 'TRUST_PROBATION',
      capability: 'custom_sending_domain',
      reason: capability.reason ?? 'probation_default_deny',
      reviewRequested: false,
      meetingUrl: null,
    });
    if (!handled) {
      showToast({
        type: 'error',
        message: t(/* i18n-dynamic */ `partnerSendingDomains.${lockedCopySuffix(capability)}`),
      });
    }
  };

  return (
    <div className="max-w-3xl space-y-4" data-testid="partner-sending-domains-tab">
      <section className="rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-semibold">{t('partnerSendingDomains.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('partnerSendingDomains.description')}</p>
        {!capability.verifiesByDns && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="sending-domains-static-note">
            {t('partnerSendingDomains.staticNote')}
          </p>
        )}
      </section>

      {!capability.eligible ? (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" data-testid="sending-domains-locked">
          <p className="text-sm font-semibold">{t('partnerSendingDomains.lockedTitle')}</p>
          <p className="mt-1 text-xs" data-testid="sending-domains-locked-reason">
            {t(/* i18n-dynamic */ `partnerSendingDomains.${lockedCopySuffix(capability)}`)}
          </p>
          {trustLock && (
            <button
              type="button"
              onClick={showVerification}
              className="mt-3 rounded-md border px-2.5 py-1.5 text-sm"
              data-testid="sending-domains-locked-trust"
            >
              {t('partnerSendingDomains.lockedShowVerification')}
            </button>
          )}
        </section>
      ) : (
        <>
          <AddDomainForm
            disabled={busy || domains.length >= capability.maxDomains}
            showRecommendation={domains.length === 0}
            onAdd={handleAdd}
          />

          {domains.map((d) => (
            <DomainStatusPanel
              key={d.id}
              domain={d}
              verifiesByDns={capability.verifiesByDns}
              busy={busy}
              nowMs={nowMs}
              onCheckNow={handleCheck}
              onRemove={handleRemove}
            >
              <TestSendControl domain={d} busy={busy} onSend={handleTest} />
            </DomainStatusPanel>
          ))}

          <SenderIdentitiesForm
            domains={domains}
            identities={identities}
            inbound={inbound}
            busy={busy}
            onSave={handleSaveIdentity}
            onClear={handleClearIdentity}
          />
        </>
      )}
    </div>
  );
}
