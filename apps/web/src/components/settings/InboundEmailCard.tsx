import { useCallback, useEffect, useState } from 'react';
import { renderTemplate, variablesForContext, type TicketTemplateVars } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { showToast } from '../shared/Toast';
import { CustomerDomainsCard } from './CustomerDomainsCard';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

// Sample values so the admin can preview how merge variables resolve in the
// acknowledgement email without sending one. The server fills these from the
// real ticket/org/partner at send time (see ticketNotifyWorker.collectAutoresponse).
const AUTORESPONSE_SAMPLE: TicketTemplateVars = {
  ticket_number: 'T-2026-0001',
  ticket_subject: 'Email not syncing',
  requester_name: 'Sample Requester',
  requester_email: 'user@example.com',
  org_name: 'Acme Corp',
  partner_name: 'Your Company',
};

// How inbound mail from an unmatched ("unknown") sender is handled. Mirrors the
// API's PartnerInboundPolicy union (settings.ticketing.inbound.unknownSenderMode).
type UnknownSenderMode = 'quarantine' | 'triage' | 'drop';

interface InboundConfig {
  enabled: boolean;
  address: string;
  addressOverride: string | null;
  inboundLocalPart: string | null;
  defaultTriageOrgId: string | null;
  autoresponderEnabled: boolean;
  unknownSenderMode: UnknownSenderMode;
  dropUnverifiedSenders: boolean;
  autoresponseSubject: string | null;
  autoresponseBody: string | null;
  slug: string;
  domainConfigured: boolean;
}

interface OrgOption {
  id: string;
  name: string;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export default function InboundEmailCard() {
  const { t } = useTranslation('settings');
  const saveError = t('inboundEmail.saveError');
  const friendlyCode = (code: string): string | undefined =>
    code === 'ORG_NOT_ACCESSIBLE' ? t('inboundEmail.orgNotAccessible') : undefined;
  const autoresponseSample: TicketTemplateVars = {
    ...AUTORESPONSE_SAMPLE,
    ticket_subject: t('inboundEmail.sample.ticketSubject'),
    requester_name: t('inboundEmail.sample.requesterName'),
    partner_name: t('inboundEmail.sample.partnerName'),
  };
  const [cfg, setCfg] = useState<InboundConfig | null>(null);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localPartDraft, setLocalPartDraft] = useState('');
  // Draft state for the auto-reply editor — kept separate from `cfg` so typing
  // doesn't auto-save; persisted explicitly via the Save button.
  const [autoSubject, setAutoSubject] = useState('');
  const [autoBody, setAutoBody] = useState('');

  const loadConfig = useCallback(async () => {
    const res = await fetchWithAuth('/ticket-config');
    if (!res.ok) {
      setError(true);
      return;
    }
    const body = (await res.json()) as { data: { inbound: InboundConfig } };
    const nextCfg: InboundConfig = {
      ...body.data.inbound,
      inboundLocalPart: body.data.inbound.inboundLocalPart ?? null,
    };
    setCfg(nextCfg);
    setLocalPartDraft(nextCfg.inboundLocalPart ?? (nextCfg.address?.split('@')[0] ?? ''));
    setAutoSubject(nextCfg.autoresponseSubject ?? '');
    setAutoBody(nextCfg.autoresponseBody ?? '');
  }, []);

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations?limit=100');
    if (res.ok) {
      const body = (await res.json()) as { data?: OrgOption[] };
      if (body.data) setOrgs(body.data);
    }
  }, []);

  const loadAll = useCallback(
    async () => {
      setLoading(true);
      setError(false);
      try {
        await Promise.all([loadConfig(), loadOrgs()]);
      } catch {
        setError(true);
      }
      setLoading(false);
    },
    [loadConfig, loadOrgs],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const saveConfig = useCallback(
    async (
      patch: Partial<
        Pick<
          InboundConfig,
          | 'enabled'
          | 'defaultTriageOrgId'
          | 'autoresponderEnabled'
          | 'unknownSenderMode'
          | 'dropUnverifiedSenders'
          | 'autoresponseSubject'
          | 'autoresponseBody'
        >
      >,
    ) => {
      if (!cfg) return;
      const next = { ...cfg, ...patch };
      // Send the COMPLETE ticketing.inbound object — PATCH /partners/me deep-merges
      // `ticketing` one level but replaces the `inbound` sub-object wholesale, so any
      // omitted inbound field is destroyed (this also retires the legacy
      // `triageUnknownSenders` key, which we no longer send).
      // Include `address` ONLY when there is a real self-hosted override (never the
      // derived value, which would persist a derived address as a spurious override).
      const inbound: Record<string, unknown> = {
        enabled: next.enabled,
        defaultTriageOrgId: next.defaultTriageOrgId,
        autoresponderEnabled: next.autoresponderEnabled,
        unknownSenderMode: next.unknownSenderMode,
        dropUnverifiedSenders: next.dropUnverifiedSenders,
        autoresponseSubject: next.autoresponseSubject,
        autoresponseBody: next.autoresponseBody,
      };
      if (next.addressOverride) inbound.address = next.addressOverride;
      setSaving(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth('/orgs/partners/me', {
              method: 'PATCH',
              body: JSON.stringify({ settings: { ticketing: { inbound } } }),
            }),
          errorFallback: saveError,
          successMessage: t('inboundEmail.saved'),
          friendly: friendlyCode,
          onUnauthorized: UNAUTHORIZED,
        });
        setCfg(next);
      } catch (err) {
        handleActionError(err, saveError);
      } finally {
        setSaving(false);
      }
    },
    [cfg, saveError, t],
  );

  const saveLocalPart = useCallback(async () => {
    if (!cfg) return;
    const value = localPartDraft.trim().toLowerCase();
    const current = cfg.inboundLocalPart ?? cfg.address.split('@')[0];
    if (value === current) return;
    const ok = window.confirm(
      t('inboundEmail.changeAddressConfirm'),
    );
    if (!ok) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            body: JSON.stringify({ inboundLocalPart: value }),
          }),
        errorFallback: saveError,
        successMessage: t('inboundEmail.addressUpdated'),
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      const domainPart = cfg.address.split('@')[1] ?? '';
      setCfg({ ...cfg, inboundLocalPart: value, address: cfg.addressOverride ?? `${value}@${domainPart}` });
    } catch (err) {
      handleActionError(err, saveError);
    } finally {
      setSaving(false);
    }
  }, [cfg, localPartDraft, saveError, t]);

  const copyAddress = useCallback(() => {
    if (cfg?.address) {
      void navigator.clipboard?.writeText(cfg.address);
      showToast({ type: 'success', message: t('inboundEmail.addressCopied') });
    }
  }, [cfg, t]);

  if (loading)
    return (
      <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-email-loading">
        {t('common:states.loading')}
      </p>
    );
  if (error || !cfg)
    return (
      <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-email-error">
        {t('inboundEmail.loadFailed')}{' '}
        <button
          type="button"
          onClick={() => void loadAll()}
          className="underline hover:text-foreground"
          data-testid="inbound-email-retry"
        >
          {t('common:actions.retry')}
        </button>
      </p>
    );

  return (
    <div className="max-w-3xl space-y-6" data-testid="inbound-email-card">
      <section className="rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-semibold">{t('inboundEmail.title')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('inboundEmail.description')}
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={saving}
            onChange={(e) => void saveConfig({ enabled: e.target.checked })}
            data-testid="inbound-enabled-toggle"
          />
          {t('inboundEmail.enable')}
        </label>

        <div className="mt-3">
          <label className="text-xs font-medium">{t('inboundEmail.address')}</label>
          {cfg.domainConfigured ? (
            <div className="mt-0.5 flex items-center gap-2">
              <input
                value={localPartDraft}
                onChange={(e) => setLocalPartDraft(e.target.value)}
                className="w-40 rounded-md border px-2.5 py-1.5 text-sm"
                data-testid="inbound-localpart"
                aria-label={t('inboundEmail.localPart')}
              />
              <span className="text-sm text-muted-foreground">@{cfg.address.split('@')[1] ?? ''}</span>
              <button
                type="button"
                onClick={saveLocalPart}
                disabled={saving || localPartDraft === (cfg.inboundLocalPart ?? cfg.address.split('@')[0])}
                className="rounded-md border px-2.5 py-1.5 text-sm"
                data-testid="inbound-localpart-save"
              >
                {t('common:actions.save')}
              </button>
              <button
                type="button"
                onClick={copyAddress}
                className="rounded-md border px-2.5 py-1.5 text-sm"
                data-testid="inbound-address-copy"
              >
                {t('common:actions.copy')}
              </button>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-amber-600" data-testid="inbound-address-unconfigured">
              {t('inboundEmail.domainNotConfigured')}
            </p>
          )}
        </div>

        <div className="mt-3">
          <label className="text-xs font-medium" htmlFor="inbound-triage-org">
            {t('inboundEmail.triageOrganization')}
          </label>
          <select
            id="inbound-triage-org"
            value={cfg.defaultTriageOrgId ?? ''}
            disabled={saving}
            onChange={(e) => void saveConfig({ defaultTriageOrgId: e.target.value || null })}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="inbound-triage-org"
          >
            <option value="">{t('common:labels.none')}</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="mt-4" data-testid="inbound-unknown-sender-mode">
          <legend className="text-xs font-medium">{t('inboundEmail.unknownSenders')}</legend>
          <p className="mb-1.5 text-xs text-muted-foreground">
            {t('inboundEmail.unknownDescription')}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="unknown-sender-mode"
              className="mt-0.5"
              checked={cfg.unknownSenderMode === 'quarantine'}
              disabled={saving}
              onChange={() => void saveConfig({ unknownSenderMode: 'quarantine' })}
              data-testid="inbound-unknown-quarantine"
            />
            <span>
              {t('inboundEmail.quarantine')} <span className="text-muted-foreground">({t('inboundEmail.default')})</span>
              <span className="block text-xs text-muted-foreground">
                {t('inboundEmail.quarantineDescription')}
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="unknown-sender-mode"
              className="mt-0.5"
              checked={cfg.unknownSenderMode === 'triage'}
              disabled={saving || !cfg.defaultTriageOrgId}
              onChange={() => void saveConfig({ unknownSenderMode: 'triage' })}
              data-testid="inbound-unknown-triage"
            />
            <span>
              {t('inboundEmail.routeToTriage')}
              <span className="block text-xs text-muted-foreground">
                {t('inboundEmail.triageDescription')}
                {!cfg.defaultTriageOrgId && ` ${t('inboundEmail.selectTriageFirst')}`}
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="unknown-sender-mode"
              className="mt-0.5"
              checked={cfg.unknownSenderMode === 'drop'}
              disabled={saving}
              onChange={() => void saveConfig({ unknownSenderMode: 'drop' })}
              data-testid="inbound-unknown-drop"
            />
            <span>
              {t('inboundEmail.dropSilently')}
              <span className="block text-xs text-muted-foreground">
                {t('inboundEmail.dropDescription')}
              </span>
            </span>
          </label>
        </fieldset>

        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={cfg.dropUnverifiedSenders}
            disabled={saving}
            onChange={(e) => void saveConfig({ dropUnverifiedSenders: e.target.checked })}
            data-testid="inbound-drop-unverified-toggle"
          />
          <span>
            {t('inboundEmail.dropUnverified')}
            <span className="block text-xs text-muted-foreground">
              <Trans i18nKey="inboundEmail.dropUnverifiedDescription" t={t} components={{ all: <em /> }} />
            </span>
          </span>
        </label>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.autoresponderEnabled}
            disabled={saving}
            onChange={(e) => void saveConfig({ autoresponderEnabled: e.target.checked })}
            data-testid="inbound-autoresponder-toggle"
          />
          {t('inboundEmail.enableAutoresponse')}
        </label>

        {cfg.autoresponderEnabled && (
          <div className="mt-4 rounded-md border bg-muted/20 p-3" data-testid="inbound-autoreply-editor">
            <p className="mb-2 text-xs font-medium">{t('inboundEmail.autoresponseMessage')}</p>

            <label className="text-xs font-medium" htmlFor="inbound-autoreply-subject">
              {t('inboundEmail.subject')}
            </label>
            <input
              id="inbound-autoreply-subject"
              type="text"
              value={autoSubject}
              disabled={saving}
              onChange={(e) => setAutoSubject(e.target.value)}
              placeholder={t('inboundEmail.subjectPlaceholder')}
              className="mt-0.5 mb-2 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              data-testid="inbound-autoreply-subject"
            />

            <label className="text-xs font-medium" htmlFor="inbound-autoreply-body">
              {t('inboundEmail.body')}
            </label>
            <textarea
              id="inbound-autoreply-body"
              value={autoBody}
              disabled={saving}
              onChange={(e) => setAutoBody(e.target.value)}
              rows={4}
              placeholder={t('inboundEmail.bodyPlaceholder')}
              className="mt-0.5 block w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm"
              data-testid="inbound-autoreply-body"
            />

            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">{t('inboundEmail.insert')}</span>
              {variablesForContext('autoreply').map((v) => (
                <button
                  key={v.key}
                  type="button"
                  disabled={saving}
                  onClick={() => setAutoBody((b) => `${b}{{${v.key}}}`)}
                  className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  data-testid={`inbound-autoreply-var-${v.key}`}
                  title={t(`inboundEmail.variables.${v.key}`)}
                >
                  {t(`inboundEmail.variables.${v.key}`)}
                </button>
              ))}
            </div>

            {autoSubject.trim() || autoBody.trim() ? (
              <div className="mt-3" data-testid="inbound-autoreply-preview">
                <p className="text-xs font-medium text-muted-foreground">{t('inboundEmail.preview')}</p>
                {autoSubject.trim() && (
                  <p className="mt-0.5 text-sm font-medium">
                    {renderTemplate(autoSubject, autoresponseSample)}
                  </p>
                )}
                {autoBody.trim() && (
                  <p className="mt-0.5 whitespace-pre-wrap text-sm">
                    {renderTemplate(autoBody, autoresponseSample)}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="inbound-autoreply-default-hint">
                {t('inboundEmail.defaultAcknowledgement')}
              </p>
            )}

            <div className="mt-3">
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void saveConfig({
                    autoresponseSubject: autoSubject.trim() ? autoSubject : null,
                    autoresponseBody: autoBody.trim() ? autoBody : null,
                  })
                }
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="inbound-autoreply-save"
              >
                {t('inboundEmail.saveAutoresponse')}
              </button>
            </div>
          </div>
        )}
      </section>

      <CustomerDomainsCard />
    </div>
  );
}
