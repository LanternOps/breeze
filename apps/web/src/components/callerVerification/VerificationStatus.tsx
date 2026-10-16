import { useTranslation } from 'react-i18next';
import type { VerificationDetails } from '@/lib/api/callerVerification';

const spaced = (code: string) => code.split('').join(' ');

/**
 * Presentation of one verification row. Challenge numbers appear only for
 * the initiating technician while the row is pending; grant freshness comes
 * from the server's `usableUntil`, never from the challenge `expiresAt`.
 */
export function VerificationStatus({ row, now = Date.now(), userId }: { row: VerificationDetails; now?: number; userId?: string }) {
  const { t } = useTranslation('callerVerificationTech');
  const action = t(/* i18n-dynamic */ `actions.${row.actionScope}`);
  const owns = !!userId && userId === row.initiatedByUserId;
  const pending = row.status === 'pending';
  const linkChallenge = pending && (row.method === 'sms' || row.method === 'email');
  const fresh = row.usableUntil !== null && Date.parse(row.usableUntil) > now;
  const tone = row.status === 'verified' && !row.consumedAt && fresh
    ? 'border-success/40 bg-success/10'
    : row.status === 'rejected_by_user' ? 'border-destructive bg-destructive/10' : 'border-border';

  return (
    <section className={`space-y-3 rounded-md border p-4 text-sm ${tone}`} data-testid="cv-status">
      <p role="status" aria-live="polite" className="font-medium">
        {row.status === 'verified' && !row.consumedAt && !fresh ? t('result.grantExpired') : t(/* i18n-dynamic */ `status.${row.status}`)}
      </p>

      {linkChallenge && owns && row.secrets && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-xs text-muted-foreground">{t('challenge.match')}</p>
              <strong data-testid="cv-match" className="block text-5xl tabular-nums">{row.secrets.matchValue}</strong>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('challenge.reverseCode')}</p>
              <strong data-testid="cv-reverse" className="block text-3xl tabular-nums">{spaced(row.secrets.reverseCode)}</strong>
            </div>
          </div>
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs font-medium text-muted-foreground">{t('challenge.scriptTitle')}</p>
            <p data-testid="cv-script">
              {t('challenge.scriptLink', {
                code: spaced(row.secrets.reverseCode), match: row.secrets.matchValue,
                action: t(/* i18n-dynamic */ `scriptActions.${row.actionScope}`), target: row.targetLabel ?? '—',
              })}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">{t('challenge.knownNumber')}</p>
        </div>
      )}
      {pending && row.destinationRedacted && <p>{t('challenge.sentTo', { destination: row.destinationRedacted })}</p>}
      {linkChallenge && !owns && <p className="text-muted-foreground">{t('challenge.notInitiator', { technician: row.technicianLabel })}</p>}
      {/* Callback attestations carry no challenge window (the server stores expiresAt = createdAt). */}
      {pending && row.method !== 'callback_attestation' && (
        <p className="text-xs text-muted-foreground">
          {t('challenge.expiresIn', { time: new Date(row.expiresAt).toLocaleTimeString() })}
        </p>
      )}

      {row.status === 'verified' && (
        row.consumedAt
          ? <p>{row.consumedAction ? t('result.consumed', { action: t(/* i18n-dynamic */ `actions.${row.consumedAction}`) }) : t('result.consumedUnknown')}</p>
          : fresh && (owns
            ? <p>{t('result.usableUntil', { action, minutes: Math.max(1, Math.ceil((Date.parse(row.usableUntil!) - now) / 60000)) })}</p>
            : <p>{t('result.anotherTechnician', { technician: row.technicianLabel })}</p>)
      )}
      {row.status === 'wrong_choice' && <p>{t('result.wrongChoiceHelp')}</p>}
      {(row.status === 'wrong_choice' || row.status === 'undeliverable') && row.remainingAttempts !== null && (
        <p>{t('result.remaining', { count: row.remainingAttempts })}</p>
      )}
      {row.status === 'undeliverable' && (
        <p>{row.undeliverableReason ? t(/* i18n-dynamic */ `undeliverable.${row.undeliverableReason}`) : t('result.undeliverableHelp')}</p>
      )}
      {row.status === 'expired' && <p>{t('result.expiredHelp')}</p>}
      {row.status === 'cancelled' && <p>{t('result.cancelledHelp')}</p>}
      {row.status === 'revoked' && <p>{t('result.revokedHelp')}</p>}
      {row.status === 'rejected_by_user' && (
        <div role="alert" className="space-y-1 font-medium text-destructive">
          <p>{t('result.rejectedHelp')}</p>
          {row.incidentId && (
            <p>
              {t('result.incident')}{' '}
              <a className="underline" href={`/incidents/${encodeURIComponent(row.incidentId)}`}>{t('result.viewIncident')}</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
