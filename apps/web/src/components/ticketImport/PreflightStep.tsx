import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { i18n } from '../../lib/i18n';
import { showToast } from '../shared/Toast';
import { PARTNER_WIDE, type ImportSource, type Preflight } from './ticketImportApi';
import { Notice, Panel, buttonPrimary, buttonSecondary, formatCount, importFriendly } from './importUi';

/**
 * Step 2, Preflight (#8313 W6; spec 2026-10-19 §5.11 step 2, §6.1): object
 * storage, the token's identity and permissions, the source version and clock
 * skew, the module's warnings, the counts, and every group with inactive and
 * unreadable ones flagged. POST /sources/:id/preflight is synchronous; its
 * catalog feeds the mappings step.
 */
type Props = {
  source: ImportSource;
  preflight: Preflight | null;
  onPreflight: (result: Preflight) => void;
  onContinue: () => void;
};

/** A preflight call, shared with the mappings step when it has no catalog yet. */
export async function runPreflight(sourceId: string, t: ReturnType<typeof useTranslation>['t']): Promise<Preflight | null> {
  try {
    const body = await runAction<{ data: Preflight }>({
      request: () => fetchWithAuth(`/ticket-imports/sources/${sourceId}/preflight`, { ...PARTNER_WIDE, method: 'POST' }),
      errorFallback: t('preflight.failed'),
      friendly: importFriendly(t),
    });
    return body.data;
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return null;
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('preflight.failed') });
    return null;
  }
}

export default function PreflightStep({ source, preflight, onPreflight, onContinue }: Props) {
  const { t } = useTranslation('ticketImport');
  const [running, setRunning] = useState(false);
  const revoked = !source.hasCredentials;

  const run = async () => {
    setRunning(true);
    const result = await runPreflight(source.id, t);
    setRunning(false);
    if (result) onPreflight(result);
  };

  const warningText = (code: string, detail?: string) => {
    const key = `ticketImport:preflight.warnings.${code}`;
    const text = i18n.exists(key) ? t(/* i18n-dynamic */ key, { detail: detail ?? '' }) : code;
    return detail && !i18n.exists(key) ? `${text}: ${detail}` : text;
  };

  return (
    <Panel
      title={t('preflight.title')}
      testId="ticket-import-preflight"
      actions={(
        <button type="button" className={preflight ? buttonSecondary : buttonPrimary} onClick={() => void run()}
          disabled={running || revoked} data-testid="ticket-import-preflight-run">
          {running ? t('preflight.running') : preflight ? t('preflight.rerun') : t('preflight.run')}
        </button>
      )}
    >
      <p className="mb-4 text-sm text-muted-foreground">{t('preflight.intro')}</p>
      {revoked && <Notice tone="warning" testId="ticket-import-preflight-revoked">{t('preflight.revoked')}</Notice>}
      {preflight && (
        <div className="space-y-4" data-testid="ticket-import-preflight-result">
          <ul className="space-y-1 text-sm">
            <Check ok={preflight.objectStorage.configured} testId="ticket-import-preflight-storage"
              text={preflight.objectStorage.configured ? t('preflight.storageOk') : t('preflight.storageMissing')} />
            <Check ok={preflight.connect.identity.key !== null} testId="ticket-import-preflight-identity"
              text={t('preflight.identity', {
                name: preflight.connect.identity.name ?? '—',
                email: preflight.connect.identity.email ?? '—',
              })} />
            <Check ok={preflight.connect.permissions.length > 0} testId="ticket-import-preflight-permissions"
              text={t('preflight.permissions', { list: preflight.connect.permissions.join(', ') || '—' })} />
            <Check ok={preflight.connect.sourceVersion != null} testId="ticket-import-preflight-version"
              text={t('preflight.version', { version: preflight.connect.sourceVersion ?? '—' })} />
            <Check ok={preflight.connect.clockSkewMs !== null && Math.abs(preflight.connect.clockSkewMs) < 300_000}
              testId="ticket-import-preflight-clock"
              text={preflight.connect.clockSkewMs === null
                ? t('preflight.clockUnknown')
                : t('preflight.clockSkew', { seconds: Math.round(preflight.connect.clockSkewMs / 1000) })} />
          </ul>

          {preflight.connect.warnings.length > 0 && (
            <div data-testid="ticket-import-preflight-warnings">
              <h3 className="mb-1 text-sm font-medium">{t('preflight.warningsTitle')}</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {preflight.connect.warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`} data-testid={`ticket-import-preflight-warning-${w.code}`}>{warningText(w.code, w.detail)}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="mb-1 text-sm font-medium">{t('preflight.countsTitle')}</h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" data-testid="ticket-import-preflight-counts">
              <dt className="text-muted-foreground">{t('preflight.counts.orgs')}</dt><dd>{formatCount(preflight.catalog.orgs.length)}</dd>
              <dt className="text-muted-foreground">{t('preflight.counts.groups')}</dt><dd>{formatCount(preflight.catalog.groups.length)}</dd>
              <dt className="text-muted-foreground">{t('preflight.counts.users')}</dt><dd>{formatCount(preflight.catalog.counts.users ?? 0)}</dd>
              <dt className="text-muted-foreground">{t('preflight.counts.states')}</dt><dd>{formatCount(preflight.catalog.states.length)}</dd>
              <dt className="text-muted-foreground">{t('preflight.counts.priorities')}</dt><dd>{formatCount(preflight.catalog.priorities.length)}</dd>
              <dt className="text-muted-foreground">{t('preflight.counts.attributes')}</dt><dd>{formatCount(preflight.catalog.attributes.length)}</dd>
              {(preflight.catalog.counts.invalidRows ?? 0) > 0 && (
                <>
                  <dt className="text-muted-foreground">{t('preflight.counts.invalidRows')}</dt>
                  <dd>{formatCount(preflight.catalog.counts.invalidRows ?? 0)}</dd>
                </>
              )}
            </dl>
          </div>

          <div>
            <h3 className="mb-1 text-sm font-medium">{t('preflight.groupsTitle')}</h3>
            <ul className="space-y-0.5 text-sm" data-testid="ticket-import-preflight-groups">
              {preflight.catalog.groups.map((g) => {
                const flag = g.active === false ? 'inactive' : g.readable === false ? 'unreadable' : null;
                return (
                  <li key={g.key} className="flex items-center gap-2" data-testid={`ticket-import-preflight-group-${g.key}`}>
                    {flag ? <AlertTriangle className="h-4 w-4 text-warning-ink" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 text-success-ink" aria-hidden="true" />}
                    <span>{g.name}</span>
                    {flag && <span className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `preflight.group.${flag}`)}</span>}
                  </li>
                );
              })}
            </ul>
          </div>

          {preflight.catalog.attributes.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">{t('preflight.attributesTitle')}</h3>
              <p className="mb-1 text-xs text-muted-foreground">{t('preflight.attributesHelp')}</p>
              <p className="text-sm" data-testid="ticket-import-preflight-attributes">{preflight.catalog.attributes.map((a) => a.name).join(', ')}</p>
            </div>
          )}

          {!preflight.objectStorage.configured && <Notice tone="warning">{t('preflight.storageBlocksImport')}</Notice>}

          <button type="button" className={buttonPrimary} onClick={onContinue} data-testid="ticket-import-preflight-continue">
            {t('common.continue')}
          </button>
        </div>
      )}
    </Panel>
  );
}

function Check({ ok, text, testId }: { ok: boolean; text: string; testId: string }) {
  return (
    <li className="flex items-start gap-2" data-testid={testId} data-ok={ok ? 'true' : 'false'}>
      {ok
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-ink" aria-hidden="true" />
        : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-ink" aria-hidden="true" />}
      <span>{text}</span>
    </li>
  );
}
