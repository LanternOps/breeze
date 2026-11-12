import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';
import { formatDateTime } from '../../lib/dateTimeFormat';
import type { MigrationWindowOpenStepUpResource } from '@breeze/shared';
import { PARTNER_WIDE, mappedOrgIds, type ImportSourceDetail, type MigrationWindow } from './ticketImportApi';
import { Notice, Panel, buttonPrimary, buttonSecondary, formatCount, importFriendly, inputClass, labelClass } from './importUi';

/**
 * Step 5, Window (#8313 W6; spec 2026-10-19 §5.11 step 5; windows spec
 * 2026-10-10 §3.1, §3.3): open a migration window over the mapped orgs, with
 * its end time and writes per hour. Only the principal's owner may, from an
 * interactive session, with MFA and a single-use step-up grant for
 * `migration_window_open` bound to exactly this window — the operation's
 * first web caller.
 *
 * As the other step-up callers (AssignParkedDeviceDialog): the first submit
 * carries no grant; a 403 STEP_UP_REQUIRED shows the factor prompt, and the
 * grant is minted for the same resource the body sends. The server spends
 * the grant last, after every check that could refuse, so a refusal other
 * than STEP_UP_REQUIRED leaves it unspent: it is held, and reused when the
 * admin retries the same window. A change to the window drops it, because
 * the grant is bound to the resource digest.
 */
type Props = {
  source: ImportSourceDetail;
  /** This source's open window, if any. */
  openWindow: MigrationWindow | null;
  /** The partner's open window when it belongs to another principal (one per partner, §3.1). */
  otherOpenWindow: MigrationWindow | null;
  partnerId: string;
  nameOfOrg: (orgId: string) => string;
  onOpened: () => void;
  onContinue: () => void;
};

const MAX_DAYS = 14;
const DEFAULT_DAYS = 3;
export const DEFAULT_WRITES_PER_HOUR = 6000;

/** A `datetime-local` value, local time, minutes precision. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultEnd(now = new Date()): string {
  const end = new Date(now.getTime() + DEFAULT_DAYS * 24 * 3600_000);
  end.setMinutes(0, 0, 0);
  return toLocalInput(end);
}

/**
 * The exact resource the grant binds and the body repeats: the shape is
 * @breeze/shared migrationWindowOpenStepUpResourceSchema, which the API's
 * mint route validates.
 */
export function windowResource(input: { partnerId: string; principalId: string; orgIds: string[]; endsAt: string; writesPerHour: number }): MigrationWindowOpenStepUpResource {
  return {
    partnerId: input.partnerId,
    principalId: input.principalId,
    orgIds: [...input.orgIds].sort(),
    endsAt: input.endsAt,
    writesPerHour: input.writesPerHour,
  };
}

export default function WindowStep({ source, openWindow, otherOpenWindow, partnerId, nameOfOrg, onOpened, onContinue }: Props) {
  const { t } = useTranslation('ticketImport');
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const isOwner = userId !== null && source.ownerUserId === userId;
  const orgIds = useMemo(() => mappedOrgIds(source.mappings), [source.mappings]);
  const [endsLocal, setEndsLocal] = useState(() => defaultEnd());
  const [writesPerHour, setWritesPerHour] = useState(String(DEFAULT_WRITES_PER_HOUR));
  const [phase, setPhase] = useState<'form' | 'stepUp'>('form');
  const [tier, setTier] = useState<ReauthTier | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A grant the server has not spent, and the resource it is bound to.
  const held = useRef<{ grant: string; key: string } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const endsAt = useMemo(() => {
    const d = new Date(endsLocal);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [endsLocal]);
  const rate = Number.parseInt(writesPerHour, 10);
  const resource = endsAt && Number.isFinite(rate)
    ? windowResource({ partnerId, principalId: source.principalId, orgIds, endsAt, writesPerHour: rate })
    : null;
  const resourceKey = resource ? JSON.stringify(resource) : null;

  // Any change to the window invalidates a held grant and a pending prompt.
  useEffect(() => {
    if (held.current && held.current.key !== resourceKey) held.current = null;
    setPhase('form');
    setCode('');
  }, [resourceKey]);

  const spanDays = endsAt ? (new Date(endsAt).getTime() - Date.now()) / (24 * 3600_000) : 0;
  const formValid = resource !== null && orgIds.length > 0 && spanDays > 0 && spanDays <= MAX_DAYS && rate >= 600;

  const discoverTier = useCallback(async (): Promise<ReauthTier | null> => {
    if (tier) return tier;
    try {
      const [userResponse, passkeyResponse] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
      if (!userResponse.ok || !passkeyResponse.ok) throw new Error('factor discovery failed');
      const user = await userResponse.json() as { mfaMethod?: string | null; totpEnrolled?: boolean } | null;
      const passkeyData = await passkeyResponse.json() as unknown;
      const passkeys = Array.isArray(passkeyData) ? passkeyData : (passkeyData as { passkeys?: unknown[] } | null)?.passkeys;
      if (!user || !Array.isArray(passkeys)) throw new Error('factor discovery failed');
      const found = pickReauthTier(passkeys.length, user.mfaMethod ?? null, user.totpEnrolled);
      setTier(found);
      return found;
    } catch {
      setError(t('window.stepUp.unavailable'));
      return null;
    }
  }, [tier, t]);

  const submit = async () => {
    if (!formValid || !resource || !resourceKey || !isOwner) return;
    setError(null);
    let grant: string | undefined;
    let minted = false;
    if (phase === 'stepUp') {
      try {
        grant = await mintStepUpGrant({
          operation: 'migration_window_open',
          resource,
          reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
        minted = true;
      } catch (err) {
        if (live.current) setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('window.stepUp.failed'));
        return;
      }
    } else if (held.current?.key === resourceKey) {
      grant = held.current.grant;
    }
    held.current = null;
    if (!live.current) return;

    try {
      await runAction({
        request: () => fetchWithAuth('/migration-windows', {
          ...PARTNER_WIDE,
          method: 'POST',
          body: JSON.stringify({
            principalId: resource.principalId,
            orgIds: resource.orgIds,
            endsAt: resource.endsAt,
            writesPerHour: resource.writesPerHour,
            sourceLabel: source.label.slice(0, 64),
            ...(grant ? { stepUpGrant: grant } : {}),
          }),
        }),
        errorFallback: t('window.openFailed'),
        friendly: importFriendly(t),
        // Every refusal is shown inline, next to the form (and the step-up prompt): no toast as well.
        suppressErrorToast: () => true,
        successMessage: t('window.opened'),
      });
      setPhase('form');
      setCode('');
      onOpened();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(t('window.openFailed'));
        return;
      }
      if (err.status === 403 && err.code === 'STEP_UP_REQUIRED') {
        if (minted) {
          // The fresh grant was refused (expired, or the session moved): prove again.
          setCode('');
          setError(t('window.stepUp.retry'));
          return;
        }
        if (!(await discoverTier())) return;
        setPhase('stepUp');
        setCode('');
        return;
      }
      // Refused before the grant was spent: keep it for a retry of this window.
      if (grant) held.current = { grant, key: resourceKey };
      setPhase('form');
      setCode('');
      setError(err.message);
    }
  };

  const handleSubmit = () => {
    if (submitting) return;
    setSubmitting(true);
    void submit().finally(() => { if (live.current) setSubmitting(false); });
  };

  if (openWindow) {
    return (
      <Panel title={t('window.title')} testId="ticket-import-window">
        <Notice tone="success" testId="ticket-import-window-open">
          {t('window.isOpen', { ends: formatDateTime(openWindow.endsAt), rate: formatCount(openWindow.writesPerHour) })}
        </Notice>
        <p className="mt-3 text-sm">{t('window.orgs', { list: openWindow.orgIds.map(nameOfOrg).join(', ') })}</p>
        <button type="button" className={`${buttonPrimary} mt-4`} onClick={onContinue} data-testid="ticket-import-window-continue">
          {t('common.continue')}
        </button>
      </Panel>
    );
  }

  const noFactor = phase === 'stepUp' && tier === 'password';

  return (
    <Panel title={t('window.title')} testId="ticket-import-window">
      <p className="mb-4 text-sm text-muted-foreground">{t('window.intro')}</p>
      <div className="mb-4 space-y-2">
        {!isOwner && <Notice testId="ticket-import-window-not-owner">{t('window.notOwner')}</Notice>}
        {otherOpenWindow && (
          <Notice tone="warning" testId="ticket-import-window-other-open">
            {t('window.otherOpen', { label: otherOpenWindow.sourceLabel })}
          </Notice>
        )}
        {orgIds.length === 0 && <Notice tone="warning" testId="ticket-import-window-no-orgs">{t('window.noOrgs')}</Notice>}
      </div>

      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <div className="sm:col-span-2">
          <p className={labelClass}>{t('window.orgsLabel')}</p>
          <p className="mt-1 text-sm" data-testid="ticket-import-window-orgs">{orgIds.map(nameOfOrg).join(', ') || '—'}</p>
        </div>
        <label className={labelClass}>
          {t('window.endsAt')}
          <input type="datetime-local" className={`${inputClass} mt-1`} value={endsLocal} onChange={(e) => setEndsLocal(e.target.value)}
            disabled={!isOwner || submitting} data-testid="ticket-import-window-ends-at" />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('window.endsAtHelp', { days: MAX_DAYS })}</span>
        </label>
        <label className={labelClass}>
          {t('window.writesPerHour')}
          <input type="number" min={600} step={100} className={`${inputClass} mt-1`} value={writesPerHour}
            onChange={(e) => setWritesPerHour(e.target.value)} disabled={!isOwner || submitting} data-testid="ticket-import-window-rate" />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('window.writesPerHourHelp')}</span>
        </label>

        {phase === 'stepUp' && (
          <div className="space-y-2 rounded-md border border-primary/40 p-3 sm:col-span-2" data-testid="ticket-import-window-stepup">
            <p className="text-sm font-medium">{t('window.stepUp.heading')}</p>
            <p className="text-xs text-muted-foreground">{t('window.stepUp.intro')}</p>
            {noFactor ? (
              <Notice tone="error" testId="ticket-import-window-stepup-no-factor">
                {t('window.stepUp.noFactor')}{' '}
                <a href="/settings/profile" target="_blank" rel="noopener noreferrer" className="font-medium underline">{t('window.stepUp.enroll')}</a>
              </Notice>
            ) : tier === 'passkey' ? (
              <p className="text-xs text-muted-foreground" data-testid="ticket-import-window-stepup-passkey">{t('window.stepUp.passkey')}</p>
            ) : (
              <label className="block text-sm">
                {t('window.stepUp.code')}
                <input className={`${inputClass} mt-1 sm:w-48`} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} disabled={submitting}
                  data-testid="ticket-import-window-stepup-code" />
              </label>
            )}
          </div>
        )}

        {error && <div className="sm:col-span-2"><Notice tone="error" testId="ticket-import-window-error">{error}</Notice></div>}

        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button
            type="submit"
            className={buttonPrimary}
            disabled={!isOwner || !formValid || submitting || noFactor || (phase === 'stepUp' && tier !== 'passkey' && code.length !== 6)}
            data-testid="ticket-import-window-open-submit"
          >
            {submitting ? t('window.opening') : phase === 'stepUp' ? t('window.stepUp.confirm') : t('window.open')}
          </button>
          {phase === 'stepUp' && (
            <button type="button" className={buttonSecondary} onClick={() => { setPhase('form'); setCode(''); setError(null); }}
              disabled={submitting} data-testid="ticket-import-window-stepup-cancel">{t('common.cancel')}</button>
          )}
        </div>
      </form>
    </Panel>
  );
}
