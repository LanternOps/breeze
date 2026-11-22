import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import HashLink from '../../shared/HashLink';
import type { DomainMethodAvailability } from './methodAvailability';
import { checkReasonLabel, entraUnavailableLabel, googleUnavailableLabel, methodLabel, verifyErrorLabel } from './labels';
import {
  DOMAIN_VERIFICATION_METHODS,
  GOOGLE_DOMAIN_SCOPE,
  customerDomainUrl,
  isDomainVerificationErrorCode,
  normalizeVerifyOutcome,
  type CustomerDomainView,
  type DomainVerificationErrorCode,
  type DomainVerificationMethod,
  type VerifyCustomerDomainOutcome,
} from './types';

type Props = {
  orgId: string;
  domain: CustomerDomainView;
  availability: DomainMethodAvailability;
  /** The row changed on the server (verified, checked, removed): reload the list. */
  onChanged: () => void;
};

/** What the last check said, rendered inline (plan Global Constraints: a check that did not pass is not an error). */
type InlineResult =
  | { kind: 'outcome'; outcome: Exclude<VerifyCustomerDomainOutcome, { result: 'verified' }> }
  | { kind: 'refused'; code: DomainVerificationErrorCode };

const toLogin = () => void navigateTo('/login', { replace: true });

/**
 * Refusals that mean the row changed under us (another admin moved, verified,
 * turned off or deleted it): the inline message explains, and the list reloads
 * so the table stops showing the old state.
 */
const STALE_ROW_CODES: ReadonlySet<DomainVerificationErrorCode> = new Set([
  'CUSTOMER_DOMAIN_NOT_FOUND', 'DOMAIN_ALREADY_VERIFIED', 'DOMAIN_INACTIVE', 'DOMAIN_VERIFIED_ELSEWHERE',
  'DOMAIN_VERIFICATION_CONFLICT_RETRY', 'DOMAIN_DNS_NOT_STARTED',
]);

function CopyField({ testId, label, value }: { testId: string; label: string; value: string }) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[DomainVerificationPanel] copy failed', err);
      showToast({ type: 'error', message: t('orgDomains.toasts.copyFailed') });
    }
  };
  return (
    <div className="space-y-1">
      <label htmlFor={`${testId}-input`} className="text-xs font-medium">{label}</label>
      <div className="flex gap-2">
        <input
          id={`${testId}-input`}
          data-testid={testId}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border bg-muted/30 px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          data-testid={`${testId}-copy`}
          onClick={() => void copy()}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          {copied ? t('orgDomains.verify.copied') : t('orgDomains.verify.copy')}
        </button>
      </div>
    </div>
  );
}

/**
 * The verify panel of one domain row (portal registration W5, Task 9): pick a
 * method, run its live check, read the result. DNS needs a token first; the
 * directory methods need the org's proven tenant / Google connection (D7, D8).
 */
export function DomainVerificationPanel({ orgId, domain, availability, onChanged }: Props) {
  const { t } = useTranslation('settings');
  const verified = domain.state === 'verified' && domain.method !== null;
  const [method, setMethod] = useState<DomainVerificationMethod>(domain.method ?? 'dns_txt');
  const [startedRecord, setStartedRecord] = useState<CustomerDomainView['dnsRecord']>(null);
  const [busy, setBusy] = useState<'start' | 'check' | 'remove' | null>(null);
  const [result, setResult] = useState<InlineResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const dnsRecord = domain.dnsRecord ?? startedRecord;
  const base = customerDomainUrl(orgId, domain.id);

  /** The reason a directory method cannot run here, in words, or null. */
  const unavailable = (m: DomainVerificationMethod): string | null => {
    if (m === 'entra_tenant') {
      const a = availability.entra_tenant;
      return a.available ? null : entraUnavailableLabel(t, a.reason);
    }
    if (m === 'google_directory') {
      const a = availability.google_directory;
      return a.available ? null : googleUnavailableLabel(t, a.reason);
    }
    return null;
  };
  const entraNotProven = !availability.entra_tenant.available && availability.entra_tenant.reason === 'tenant_not_proven';
  // A verified row keeps its method until the verification is removed (DOMAIN_ALREADY_VERIFIED).
  const methodDisabled = (m: DomainVerificationMethod) => (verified ? m !== domain.method : unavailable(m) !== null);

  const selectMethod = (m: DomainVerificationMethod) => {
    setMethod(m);
    setResult(null);
  };

  const startDns = async () => {
    setBusy('start');
    try {
      const body = await runAction<{ data: { recordName: string; recordValue: string } }>({
        request: () => fetchWithAuth(`${base}/verification/dns`, { method: 'POST' }),
        errorFallback: t('orgDomains.errors.startDns'),
        parseSuccess: (data) => {
          const rec = (data as { data?: { recordName?: unknown; recordValue?: unknown } } | null)?.data;
          if (typeof rec?.recordName !== 'string' || typeof rec.recordValue !== 'string') {
            throw new Error('unexpected DNS verification body');
          }
          return { data: { recordName: rec.recordName, recordValue: rec.recordValue } };
        },
        friendly: (code) => (isDomainVerificationErrorCode(code) ? verifyErrorLabel(t, code) : undefined),
        onUnauthorized: toLogin,
      });
      setStartedRecord(body.data);
      onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        console.error('[DomainVerificationPanel] DNS start failed', err);
        showToast({ type: 'error', message: t('orgDomains.errors.startDns') });
      }
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy('check');
    setResult(null);
    try {
      const body = await runAction<{ data: VerifyCustomerDomainOutcome }>({
        request: () => fetchWithAuth(`${base}/verification/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method }),
        }),
        errorFallback: t('orgDomains.errors.check'),
        parseSuccess: (data) => {
          const outcome = normalizeVerifyOutcome((data as { data?: unknown } | null)?.data);
          if (!outcome) throw new Error('unexpected verification check body');
          return { data: outcome };
        },
        // Only a pass is a success toast; a failed / unavailable check renders inline.
        successMessage: (b) => (b.data.result === 'verified' ? t('orgDomains.toasts.verified', { domain: domain.domain }) : ''),
        friendly: (code) => (isDomainVerificationErrorCode(code) ? verifyErrorLabel(t, code) : undefined),
        // A verification refusal belongs to this panel, next to the button that caused it.
        suppressErrorToast: (_status, code) => isDomainVerificationErrorCode(code),
        onUnauthorized: toLogin,
      });
      if (body.data.result !== 'verified') setResult({ kind: 'outcome', outcome: body.data });
      onChanged();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        if (isDomainVerificationErrorCode(err.code)) {
          setResult({ kind: 'refused', code: err.code });
          if (STALE_ROW_CODES.has(err.code)) onChanged();
        }
        return;
      }
      console.error('[DomainVerificationPanel] check failed', err);
      showToast({ type: 'error', message: t('orgDomains.errors.check') });
    } finally {
      setBusy(null);
    }
  };

  const removeVerification = async () => {
    setBusy('remove');
    try {
      await runAction({
        request: () => fetchWithAuth(`${base}/verification`, { method: 'DELETE' }),
        errorFallback: t('orgDomains.errors.removeVerification'),
        successMessage: t('orgDomains.toasts.verificationRemoved', { domain: domain.domain }),
        friendly: (code) => (isDomainVerificationErrorCode(code) ? verifyErrorLabel(t, code) : undefined),
        onUnauthorized: toLogin,
      });
      setConfirmRemove(false);
      setResult(null);
      onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        console.error('[DomainVerificationPanel] remove verification failed', err);
        showToast({ type: 'error', message: t('orgDomains.errors.removeVerification') });
      }
    } finally {
      setBusy(null);
    }
  };

  const canCheck = domain.isActive && busy === null && !methodDisabled(method) && (method !== 'dns_txt' || dnsRecord !== null);

  return (
    <div className="space-y-4 rounded-md border bg-muted/20 p-4" data-testid="domain-verification-panel">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('orgDomains.verify.methodLegend')}</legend>
        {DOMAIN_VERIFICATION_METHODS.map((m) => {
          const reason = unavailable(m);
          return (
            <div key={m} className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`domain-method-${domain.id}`}
                  value={m}
                  checked={method === m}
                  disabled={methodDisabled(m)}
                  onChange={() => selectMethod(m)}
                  aria-describedby={!verified && reason ? `domain-method-why-${domain.id}-${m}` : undefined}
                  data-testid={`domain-method-${m}`}
                />
                {methodLabel(t, m)}
              </label>
              {!verified && reason && (
                <p
                  id={`domain-method-why-${domain.id}-${m}`}
                  className="ml-6 text-xs text-muted-foreground"
                  data-testid={`domain-method-unavailable-${m}`}
                >
                  {reason}
                  {m === 'entra_tenant' && entraNotProven && (
                    <>
                      {' '}
                      <HashLink hash="portal" className="underline hover:text-foreground">{t('orgDomains.verify.openPortalTab')}</HashLink>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
        {verified && (
          <p className="text-xs text-muted-foreground" data-testid="domain-method-locked">{t('orgDomains.verify.methodLocked')}</p>
        )}
      </fieldset>

      {method === 'dns_txt' && (
        <div className="space-y-2">
          {dnsRecord ? (
            <>
              <p className="text-xs text-muted-foreground">{t('orgDomains.verify.dnsInstructions')}</p>
              <CopyField testId="domain-dns-record-name" label={t('orgDomains.verify.recordName')} value={dnsRecord.recordName} />
              <CopyField testId="domain-dns-record-value" label={t('orgDomains.verify.recordValue')} value={dnsRecord.recordValue} />
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('orgDomains.verify.dnsStartHint')}</p>
              <button
                type="button"
                data-testid="domain-dns-start"
                onClick={() => void startDns()}
                disabled={busy !== null || !domain.isActive}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                {busy === 'start' ? t('orgDomains.verify.starting') : t('orgDomains.verify.startDns')}
              </button>
            </div>
          )}
        </div>
      )}

      {method === 'google_directory' && !verified && (
        <p className="text-xs text-muted-foreground">{t('orgDomains.verify.googleScopeHint', { scope: GOOGLE_DOMAIN_SCOPE })}</p>
      )}

      {!domain.isActive && (
        <p className="text-xs text-amber-700" data-testid="domain-verify-inactive">{t('orgDomains.verify.inactive')}</p>
      )}

      {/* Always mounted, so screen readers announce a result that appears in it. */}
      <div role="status" aria-live="polite">
        {result && (
          <div
            data-testid="domain-verify-result"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {result.kind === 'refused'
              ? verifyErrorLabel(t, result.code)
              : result.outcome.result === 'failed'
                ? t('orgDomains.verify.resultFailed', { reason: checkReasonLabel(t, result.outcome.reason) })
                : t('orgDomains.verify.resultUnavailable', { reason: checkReasonLabel(t, result.outcome.reason) })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="domain-verify-check"
          onClick={() => void check()}
          disabled={!canCheck}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy === 'check' ? t('orgDomains.verify.checking') : verified ? t('orgDomains.verify.checkNow') : t('orgDomains.verify.verify')}
        </button>
        {verified && (
          <button
            type="button"
            data-testid="domain-verify-remove"
            onClick={() => setConfirmRemove(true)}
            disabled={busy !== null}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t('orgDomains.verify.removeVerification')}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => { if (busy === null) setConfirmRemove(false); }}
        onConfirm={() => void removeVerification()}
        title={t('orgDomains.verify.removeTitle', { domain: domain.domain })}
        message={t('orgDomains.verify.removeMessage')}
        confirmLabel={t('orgDomains.verify.removeVerification')}
        variant="warning"
        isLoading={busy === 'remove'}
        confirmTestId="domain-verify-remove-confirm"
      />
    </div>
  );
}
