// The SNMP field block. Presentational: it owns no requests and no draft — the
// Monitoring section holds both, so the same fields can serve a create (PUT)
// and an edit (PATCH) without two copies of the markup.
//
// Credential fields are ALWAYS blank on open. The API returns them masked
// (`serializeSnmpDevice`, monitoring.ts:114-122); echoing that mask into an
// input and saving it would send `********` back as the literal secret.

import { useTranslation } from 'react-i18next';

import type { SnmpAuthProtocol, SnmpPrivProtocol, SnmpVersion, TemplateSuggestion } from './useNetworkAssetMutations';

export type SnmpDraft = {
  snmpVersion: SnmpVersion;
  community: string;
  username: string;
  authProtocol: SnmpAuthProtocol;
  authPassword: string;
  privProtocol: SnmpPrivProtocol;
  privPassword: string;
  templateId: string;
  pollingInterval: number;
  port: number;
};

export type SnmpTemplateOption = { id: string; name: string; vendor?: string };

const FIELD_CLASS =
  'mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const LABEL_CLASS = 'block text-xs font-medium text-muted-foreground';

export function SnmpConfigForm({
  draft,
  onChange,
  templates,
  templatesError,
  suggestion,
  onUseSuggestion,
  hasStoredCommunity,
  hasStoredAuthPassword,
  hasStoredPrivPassword,
  disabled,
}: {
  draft: SnmpDraft;
  onChange: (patch: Partial<SnmpDraft>) => void;
  templates: SnmpTemplateOption[];
  templatesError: boolean;
  suggestion: TemplateSuggestion | null;
  onUseSuggestion: () => void;
  hasStoredCommunity: boolean;
  hasStoredAuthPassword: boolean;
  hasStoredPrivPassword: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation('devices');

  const storedHint = (testId: string, stored: boolean) =>
    stored ? (
      <span className="ml-1 text-muted-foreground/70" data-testid={testId}>
        {t('networkDeviceDetailPage.settings.monitoring.leaveBlankToKeep')}
      </span>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-version">
            {t('networkDeviceDetailPage.settings.monitoring.snmpVersion')}
          </label>
          <select
            id="network-settings-snmp-version"
            data-testid="network-settings-snmp-version"
            value={draft.snmpVersion}
            disabled={disabled}
            onChange={(e) => onChange({ snmpVersion: e.target.value as SnmpVersion })}
            className={FIELD_CLASS}
          >
            <option value="v1">v1</option>
            <option value="v2c">v2c</option>
            <option value="v3">v3</option>
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-interval">
            {t('networkDeviceDetailPage.settings.monitoring.pollingInterval')}
          </label>
          <input
            id="network-settings-snmp-interval"
            data-testid="network-settings-snmp-interval"
            type="number"
            min={30}
            max={86400}
            value={draft.pollingInterval}
            disabled={disabled}
            onChange={(e) => onChange({ pollingInterval: Number(e.target.value) })}
            className={FIELD_CLASS}
          />
        </div>
      </div>

      {(draft.snmpVersion === 'v1' || draft.snmpVersion === 'v2c') && (
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-community">
            {t('networkDeviceDetailPage.settings.monitoring.community')}
            {storedHint('network-settings-snmp-community-stored', hasStoredCommunity)}
          </label>
          <input
            id="network-settings-snmp-community"
            data-testid="network-settings-snmp-community"
            type="text"
            autoComplete="off"
            value={draft.community}
            disabled={disabled}
            onChange={(e) => onChange({ community: e.target.value })}
            className={FIELD_CLASS}
          />
        </div>
      )}

      {draft.snmpVersion === 'v3' && (
        <>
          <div>
            <label className={LABEL_CLASS} htmlFor="network-settings-snmp-username">
              {t('networkDeviceDetailPage.settings.monitoring.username')}
            </label>
            <input
              id="network-settings-snmp-username"
              data-testid="network-settings-snmp-username"
              type="text"
              autoComplete="off"
              value={draft.username}
              disabled={disabled}
              onChange={(e) => onChange({ username: e.target.value })}
              className={FIELD_CLASS}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-auth-protocol">
                {t('networkDeviceDetailPage.settings.monitoring.authProtocol')}
              </label>
              <select
                id="network-settings-snmp-auth-protocol"
                data-testid="network-settings-snmp-auth-protocol"
                value={draft.authProtocol}
                disabled={disabled}
                onChange={(e) => onChange({ authProtocol: e.target.value as SnmpAuthProtocol })}
                className={FIELD_CLASS}
              >
                <option value="md5">MD5</option>
                <option value="sha">SHA</option>
                <option value="sha256">SHA-256</option>
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-auth-password">
                {t('networkDeviceDetailPage.settings.monitoring.authPassword')}
                {storedHint('network-settings-snmp-auth-password-stored', hasStoredAuthPassword)}
              </label>
              <input
                id="network-settings-snmp-auth-password"
                data-testid="network-settings-snmp-auth-password"
                type="password"
                autoComplete="new-password"
                value={draft.authPassword}
                disabled={disabled}
                onChange={(e) => onChange({ authPassword: e.target.value })}
                className={FIELD_CLASS}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-priv-protocol">
                {t('networkDeviceDetailPage.settings.monitoring.privacyProtocol')}
              </label>
              <select
                id="network-settings-snmp-priv-protocol"
                data-testid="network-settings-snmp-priv-protocol"
                value={draft.privProtocol}
                disabled={disabled}
                onChange={(e) => onChange({ privProtocol: e.target.value as SnmpPrivProtocol })}
                className={FIELD_CLASS}
              >
                <option value="des">DES</option>
                <option value="aes">AES</option>
                <option value="aes256">AES-256</option>
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-priv-password">
                {t('networkDeviceDetailPage.settings.monitoring.privacyPassword')}
                {storedHint('network-settings-snmp-priv-password-stored', hasStoredPrivPassword)}
              </label>
              <input
                id="network-settings-snmp-priv-password"
                data-testid="network-settings-snmp-priv-password"
                type="password"
                autoComplete="new-password"
                value={draft.privPassword}
                disabled={disabled}
                onChange={(e) => onChange({ privPassword: e.target.value })}
                className={FIELD_CLASS}
              />
            </div>
          </div>
        </>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-port">
            {t('networkDeviceDetailPage.settings.monitoring.port')}
          </label>
          <input
            id="network-settings-snmp-port"
            data-testid="network-settings-snmp-port"
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            disabled={disabled}
            onChange={(e) => onChange({ port: Number(e.target.value) })}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-template">
            {t('networkDeviceDetailPage.settings.monitoring.template')}
          </label>
          {templatesError ? (
            <p className="mt-1 text-xs text-warning">
              {t('networkDeviceDetailPage.settings.monitoring.templatesUnavailable')}
            </p>
          ) : (
            <select
              id="network-settings-snmp-template"
              data-testid="network-settings-snmp-template"
              value={draft.templateId}
              disabled={disabled}
              onChange={(e) => onChange({ templateId: e.target.value })}
              className={FIELD_CLASS}
            >
              <option value="">{t('networkDeviceDetailPage.settings.monitoring.noTemplate')}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}{template.vendor ? ` (${template.vendor})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* W03 only. Absent on a pre-W03 API, and the section works without it —
          the whole block simply does not render (spec §16). */}
      {suggestion && (
        <p className="text-xs text-muted-foreground" data-testid="network-settings-snmp-suggestion">
          {t('networkDeviceDetailPage.settings.monitoring.suggestion', {
            template: suggestion.templateName,
            reason: suggestion.reason,
          })}{' '}
          {draft.templateId !== suggestion.templateId && (
            <button
              type="button"
              data-testid="network-settings-snmp-suggestion-apply"
              onClick={onUseSuggestion}
              disabled={disabled}
              className="text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.settings.monitoring.useSuggestion')}
            </button>
          )}
        </p>
      )}

      {/* No template at all is the F2 failure mode: "SNMP monitoring: Enabled"
          while the poller has no OIDs to ask for and says nothing. */}
      {!draft.templateId && !templatesError && (
        <p className="text-xs text-warning" data-testid="network-settings-snmp-no-template-warning">
          {t('networkDeviceDetailPage.settings.monitoring.noTemplateWarning')}
        </p>
      )}
    </div>
  );
}
