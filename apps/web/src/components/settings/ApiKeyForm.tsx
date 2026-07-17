import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export type ApiKeyScope = {
  id: string;
  labelKey: string;
  descriptionKey: string;
  adminOnly?: boolean;
};

export const API_KEY_SCOPES: ApiKeyScope[] = [
  { id: 'devices:read', labelKey: 'apiKeyForm.devicesRead', descriptionKey: 'apiKeyForm.viewDeviceInformationAndStatus' },
  { id: 'devices:write', labelKey: 'apiKeyForm.devicesWrite', descriptionKey: 'apiKeyForm.createUpdateAndDeleteDevices' },
  { id: 'scripts:read', labelKey: 'apiKeyForm.scriptsRead', descriptionKey: 'apiKeyForm.viewScriptsAndExecutionHistory' },
  { id: 'scripts:write', labelKey: 'apiKeyForm.scriptsWrite', descriptionKey: 'apiKeyForm.createAndModifyScripts' },
  { id: 'scripts:execute', labelKey: 'apiKeyForm.scriptsExecute', descriptionKey: 'apiKeyForm.runScriptsOnDevices' },
  { id: 'alerts:read', labelKey: 'apiKeyForm.alertsRead', descriptionKey: 'apiKeyForm.viewAlertsAndNotifications' },
  { id: 'alerts:write', labelKey: 'apiKeyForm.alertsWrite', descriptionKey: 'apiKeyForm.createAndManageAlertRules' },
  { id: 'reports:read', labelKey: 'apiKeyForm.reportsRead', descriptionKey: 'apiKeyForm.viewAndDownloadReports' },
  { id: 'reports:write', labelKey: 'apiKeyForm.reportsWrite', descriptionKey: 'apiKeyForm.createAndScheduleReports' },
  { id: 'ai:read', labelKey: 'apiKeyForm.aIRead', descriptionKey: 'apiKeyForm.queryDevicesAlertsAndMetricsViaAIMCP' },
  { id: 'ai:write', labelKey: 'apiKeyForm.aIWrite', descriptionKey: 'apiKeyForm.createAutomationsAndManageAlertsViaAIMCP' },
  { id: 'ai:execute', labelKey: 'apiKeyForm.aIExecute', descriptionKey: 'apiKeyForm.executeCommandsAndScriptsViaAIMCP', adminOnly: true },
  { id: 'users:read', labelKey: 'apiKeyForm.usersRead', descriptionKey: 'apiKeyForm.viewUserInformation', adminOnly: true }
];

export type ApiKeyFormValues = {
  name: string;
  expiresAt: string | null;
  rateLimit: number | null;
  scopes: string[];
  /** Target org, set by the in-form selector when no org context is active. */
  orgId?: string;
};

type ApiKeyFormProps = {
  isOpen: boolean;
  onSubmit: (values: ApiKeyFormValues) => Promise<void>;
  onCancel: () => void;
  loading?: boolean;
  title?: string;
  description?: string;
  initialValues?: Partial<ApiKeyFormValues>;
  isAdmin?: boolean;
  /** When set, the form requires picking a target org (fleet view: no org
   * context to inherit — keys are org-scoped objects). */
  organizations?: Array<{ id: string; name: string }>;
};

type CreatedKeyModalProps = {
  isOpen: boolean;
  apiKey: string;
  onClose: () => void;
};

export function CreatedKeyModal({ isOpen, apiKey, onClose }: CreatedKeyModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10">
            <svg
              className="h-5 w-5 text-emerald-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{i18n.t('settings:apiKeyForm.aPIKeyCreated')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {i18n.t('settings:apiKeyForm.yourNewAPIKeyHasBeenCreatedSuccessfully')}</p>
          </div>
        </div>

        <div className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-sm font-medium text-amber-800">
              {i18n.t('settings:apiKeyForm.thisKeyWillOnlyBeShownOncePleaseCopyAndStoreItSecurely')}</p>
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="api-key-value" className="text-sm font-medium">
            {i18n.t('settings:apiKeyForm.yourAPIKey')}</label>
          <div className="mt-2 flex gap-2">
            <input
              id="api-key-value"
              type="text"
              value={apiKey}
              readOnly
              className="h-10 flex-1 rounded-md border bg-muted px-3 font-mono text-sm"
            />
            <button
              type="button"
              onClick={handleCopy}
              className={cn(
                'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition',
                copied
                  ? 'bg-emerald-500 text-white'
                  : 'bg-primary text-primary-foreground hover:opacity-90'
              )}
            >
              {copied ? (
                <>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {i18n.t('settings:apiKeyForm.copied')}</>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                  {i18n.t('settings:apiKeyForm.copy')}</>
              )}
            </button>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {i18n.t('settings:apiKeyForm.done')}</button>
        </div>
      </div>
    </div>
  );
}

export default function ApiKeyForm({
  isOpen,
  onSubmit,
  onCancel,
  loading = false,
  title = 'Create API Key',
  description = 'Create a new API key with specific permissions.',
  initialValues,
  isAdmin = false,
  organizations
}: ApiKeyFormProps) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(initialValues?.name ?? '');
  const [expiresAt, setExpiresAt] = useState(initialValues?.expiresAt ?? '');
  const [neverExpires, setNeverExpires] = useState(!initialValues?.expiresAt);
  const [rateLimit, setRateLimit] = useState<string>(
    initialValues?.rateLimit?.toString() ?? ''
  );
  const [scopes, setScopes] = useState<string[]>(initialValues?.scopes ?? []);
  const [orgId, setOrgId] = useState(initialValues?.orgId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const needsOrgPick = !!organizations && organizations.length > 0;

  const handleScopeToggle = (scopeId: string) => {
    setScopes(prev =>
      prev.includes(scopeId) ? prev.filter(s => s !== scopeId) : [...prev, scopeId]
    );
  };

  const handleSelectAll = () => {
    const availableScopes = API_KEY_SCOPES.filter(scope => !scope.adminOnly || isAdmin);
    setScopes(availableScopes.map(s => s.id));
  };

  const handleClearAll = () => {
    setScopes([]);
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = 'Name is required';
    } else if (name.length > 100) {
      newErrors.name = 'Name must be 100 characters or less';
    }

    if (!neverExpires && !expiresAt) {
      newErrors.expiresAt = 'Expiration date is required when not set to never expire';
    }

    if (rateLimit && (isNaN(Number(rateLimit)) || Number(rateLimit) < 1)) {
      newErrors.rateLimit = 'Rate limit must be a positive number';
    }

    if (scopes.length === 0) {
      newErrors.scopes = 'At least one scope is required';
    }

    if (needsOrgPick && !orgId) {
      newErrors.orgId = t('apiKeyForm.organizationRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!validate()) return;

    await onSubmit({
      name: name.trim(),
      expiresAt: neverExpires ? null : expiresAt || null,
      rateLimit: rateLimit ? Number(rateLimit) : null,
      scopes,
      ...(needsOrgPick ? { orgId } : {})
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs my-8">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          {/* Name */}
          <div className="space-y-2">
            <label htmlFor="api-key-name" className="text-sm font-medium">
              {t('apiKeyForm.name')}<span className="text-destructive">*</span>
            </label>
            <input
              id="api-key-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('apiKeyForm.myAPIKey')}
              className={cn(
                'h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring',
                errors.name && 'border-destructive focus:ring-destructive'
              )}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>

          {/* Target organization — API keys are org-scoped; in fleet view there
              is no org context to inherit, so the form asks instead of failing
              after submit. */}
          {needsOrgPick && (
            <div className="space-y-2">
              <label htmlFor="api-key-org" className="text-sm font-medium">
                {t('apiKeyForm.organization')}<span className="text-destructive">*</span>
              </label>
              <select
                id="api-key-org"
                data-testid="api-key-org-select"
                value={orgId}
                onChange={e => setOrgId(e.target.value)}
                className={cn(
                  'h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring',
                  errors.orgId && 'border-destructive focus:ring-destructive'
                )}
              >
                <option value="" disabled>{t('apiKeyForm.selectOrganization')}</option>
                {organizations!.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              {errors.orgId && <p className="text-xs text-destructive">{errors.orgId}</p>}
            </div>
          )}

          {/* Expiration */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('apiKeyForm.expiration')}</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={neverExpires}
                  onChange={e => setNeverExpires(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                {t('apiKeyForm.neverExpires')}</label>
            </div>
            {!neverExpires && (
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                min="2024-01-15"
                className={cn(
                  'h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring',
                  errors.expiresAt && 'border-destructive focus:ring-destructive'
                )}
              />
            )}
            {errors.expiresAt && <p className="text-xs text-destructive">{errors.expiresAt}</p>}
          </div>

          {/* Rate Limit */}
          <div className="space-y-2">
            <label htmlFor="api-key-rate-limit" className="text-sm font-medium">
              {t('apiKeyForm.rateLimitRequestsPerHour')}</label>
            <input
              id="api-key-rate-limit"
              type="number"
              value={rateLimit}
              onChange={e => setRateLimit(e.target.value)}
              placeholder={t('apiKeyForm.leaveEmptyForDefault')}
              min={1}
              className={cn(
                'h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring',
                errors.rateLimit && 'border-destructive focus:ring-destructive'
              )}
            />
            {errors.rateLimit && <p className="text-xs text-destructive">{errors.rateLimit}</p>}
            <p className="text-xs text-muted-foreground">
              {t('apiKeyForm.optionalLeaveEmptyToUseTheDefaultRateLimit')}</p>
          </div>

          {/* Scopes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                {t('apiKeyForm.scopes')}<span className="text-destructive">*</span>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t('apiKeyForm.selectAll')}</button>
                <span className="text-muted-foreground">|</span>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t('apiKeyForm.clearAll')}</button>
              </div>
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
              {API_KEY_SCOPES.map(scope => {
                const isDisabled = scope.adminOnly && !isAdmin;
                return (
                  <label
                    key={scope.id}
                    className={cn(
                      'flex items-start gap-3 rounded-md p-2 transition',
                      isDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted cursor-pointer'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope.id)}
                      onChange={() => handleScopeToggle(scope.id)}
                      disabled={isDisabled}
                      className="mt-0.5 h-4 w-4 rounded border-border"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t(/* i18n-dynamic */ scope.labelKey)}</span>
                        {scope.adminOnly && (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                            {t('apiKeyForm.adminOnly')}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ scope.descriptionKey)}</p>
                    </div>
                  </label>
                );
              })}
            </div>
            {errors.scopes && <p className="text-xs text-destructive">{errors.scopes}</p>}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {t('apiKeyForm.cancel')}</button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? t('apiKeyForm.creating') : t('apiKeyForm.createKey')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
