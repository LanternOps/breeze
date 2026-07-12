import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Lock, Save, ShieldCheck, ShieldOff, Timer, Fingerprint } from 'lucide-react';
import { useOrgStore } from '../../stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';

type SecurityData = {
  minLength?: number;
  complexity?: string;
  expirationDays?: number;
  requireMfa?: boolean;
  allowedMethods?: { totp: boolean; sms: boolean };
  sessionTimeout?: number;
  maxSessions?: number;
  ipAllowlist?: string;
};

type MtlsSettings = {
  certLifetimeDays?: number;
  expiredCertPolicy?: 'auto_reissue' | 'quarantine';
};

type OrgSecuritySettingsProps = {
  security?: SecurityData;
  mtls?: MtlsSettings;
  onDirty?: () => void;
  onSave?: (data: SecurityData) => void;
  locked?: string[];
};

const defaultSecurity: SecurityData = {
  minLength: 12,
  complexity: 'standard',
  expirationDays: 90,
  requireMfa: true,
  allowedMethods: { totp: true, sms: false },
  sessionTimeout: 60,
  maxSessions: 3,
  ipAllowlist: ''
};

export default function OrgSecuritySettings({ security, mtls, onDirty, onSave, locked }: OrgSecuritySettingsProps) {
  const { t } = useTranslation('settings');
  const isLocked = (field: string) => locked?.includes(`security.${field}`) ?? false;

  const initialData = { ...defaultSecurity, ...security };
  const [minLength, setMinLength] = useState(initialData.minLength || 12);
  const [complexity, setComplexity] = useState(initialData.complexity || 'standard');
  const [expirationDays, setExpirationDays] = useState(initialData.expirationDays || 90);
  const [requireMfa, setRequireMfa] = useState(initialData.requireMfa ?? true);
  const [allowedMethods, setAllowedMethods] = useState(initialData.allowedMethods || { totp: true, sms: false });
  const [sessionTimeout, setSessionTimeout] = useState(initialData.sessionTimeout || 60);
  const [maxSessions, setMaxSessions] = useState(initialData.maxSessions || 3);
  const [ipAllowlist, setIpAllowlist] = useState(initialData.ipAllowlist || '');

  // mTLS state
  const [certLifetimeDays, setCertLifetimeDays] = useState(mtls?.certLifetimeDays ?? 90);
  const [expiredCertPolicy, setExpiredCertPolicy] = useState<'auto_reissue' | 'quarantine'>(mtls?.expiredCertPolicy ?? 'auto_reissue');
  const [mtlsSaving, setMtlsSaving] = useState(false);
  const [mtlsError, setMtlsError] = useState<string>();
  const [mtlsSuccess, setMtlsSuccess] = useState(false);

  const { currentOrgId } = useOrgStore();

  const markDirty = () => {
    onDirty?.();
  };

  const handleSave = () => {
    const data: SecurityData = {
      minLength,
      complexity,
      expirationDays,
      requireMfa,
      allowedMethods,
      sessionTimeout,
      maxSessions,
      ipAllowlist
    };
    onSave?.(data);
  };

  const handleMtlsSave = async () => {
    if (!currentOrgId) return;

    setMtlsSaving(true);
    setMtlsError(undefined);
    setMtlsSuccess(false);

    try {
      const response = await fetchWithAuth(`/agents/org/${currentOrgId}/settings/mtls`, {
        method: 'PATCH',
        body: JSON.stringify({
          certLifetimeDays,
          expiredCertPolicy,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || t('orgSecuritySettings.mtls.errors.save'));
      }

      setMtlsSuccess(true);
      setTimeout(() => setMtlsSuccess(false), 3000);
    } catch (err) {
      setMtlsError(err instanceof Error ? err.message : t('orgSecuritySettings.mtls.errors.save'));
    } finally {
      setMtlsSaving(false);
    }
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('orgSecuritySettings.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('orgSecuritySettings.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          {t('orgSecuritySettings.actions.save')}
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lock className="h-4 w-4" />
            {t('orgSecuritySettings.password.title')}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('orgSecuritySettings.password.minLength')}</label>
              <input
                type="number"
                min={8}
                max={32}
                value={minLength}
                disabled={isLocked('minLength')}
                onChange={event => {
                  setMinLength(Number(event.target.value));
                  markDirty();
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('minLength') ? 'opacity-60' : ''}`}
              />
              {isLocked('minLength') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('orgSecuritySettings.password.complexity')}</label>
              <select
                value={complexity}
                disabled={isLocked('complexity')}
                onChange={event => {
                  setComplexity(event.target.value);
                  markDirty();
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('complexity') ? 'opacity-60' : ''}`}
              >
                <option value="standard">{t('orgSecuritySettings.password.complexityOptions.standard')}</option>
                <option value="strict">{t('orgSecuritySettings.password.complexityOptions.strict')}</option>
                <option value="passphrase">{t('orgSecuritySettings.password.complexityOptions.passphrase')}</option>
              </select>
              {isLocked('complexity') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('orgSecuritySettings.password.expirationDays')}</label>
              <input
                type="number"
                min={30}
                max={365}
                value={expirationDays}
                disabled={isLocked('expirationDays')}
                onChange={event => {
                  setExpirationDays(Number(event.target.value));
                  markDirty();
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('expirationDays') ? 'opacity-60' : ''}`}
              />
              {isLocked('expirationDays') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('orgSecuritySettings.password.description')}
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            {requireMfa ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
            {t('orgSecuritySettings.mfa.title')}
          </div>
          <label className={`flex items-center justify-between gap-4 text-sm ${isLocked('requireMfa') ? 'opacity-60' : ''}`}>
            <span>{t('orgSecuritySettings.mfa.requireAll')}</span>
            <input
              type="checkbox"
              checked={requireMfa}
              disabled={isLocked('requireMfa')}
              onChange={event => {
                setRequireMfa(event.target.checked);
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
          {isLocked('requireMfa') && (
            <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
          )}
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">{t('orgSecuritySettings.mfa.allowedMethods')}</p>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>{t('orgSecuritySettings.mfa.totp')}</span>
              <input
                type="checkbox"
                checked={allowedMethods.totp}
                onChange={event => {
                  setAllowedMethods(prev => ({ ...prev, totp: event.target.checked }));
                  markDirty();
                }}
                className="h-4 w-4"
              />
            </label>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>{t('orgSecuritySettings.mfa.sms')}</span>
              <input
                type="checkbox"
                checked={allowedMethods.sms}
                onChange={event => {
                  setAllowedMethods(prev => ({ ...prev, sms: event.target.checked }));
                  markDirty();
                }}
                className="h-4 w-4"
              />
            </label>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Timer className="h-4 w-4" />
            {t('orgSecuritySettings.sessions.title')}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('orgSecuritySettings.sessions.timeout')}</label>
              <input
                type="number"
                min={15}
                max={240}
                value={sessionTimeout}
                disabled={isLocked('sessionTimeout')}
                onChange={event => {
                  setSessionTimeout(Number(event.target.value));
                  markDirty();
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('sessionTimeout') ? 'opacity-60' : ''}`}
              />
              {isLocked('sessionTimeout') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('orgSecuritySettings.sessions.maxSessions')}</label>
              <input
                type="number"
                min={1}
                max={10}
                value={maxSessions}
                disabled={isLocked('maxSessions')}
                onChange={event => {
                  setMaxSessions(Number(event.target.value));
                  markDirty();
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('maxSessions') ? 'opacity-60' : ''}`}
              />
              {isLocked('maxSessions') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('orgSecuritySettings.sessions.description')}
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            {t('orgSecuritySettings.ipAllowlist.title')}
          </div>
          <textarea
            value={ipAllowlist}
            disabled={isLocked('ipAllowlist')}
            onChange={event => {
              setIpAllowlist(event.target.value);
              markDirty();
            }}
            rows={5}
            className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${isLocked('ipAllowlist') ? 'opacity-60' : ''}`}
            placeholder={t('orgSecuritySettings.ipAllowlist.placeholder')}
          />
          {isLocked('ipAllowlist') && (
            <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgSecuritySettings.managedByPartner')}</span>
          )}
          <p className="text-xs text-muted-foreground">
            {t('orgSecuritySettings.ipAllowlist.description')}
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t" />

      {/* mTLS Certificate Policy */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t('orgSecuritySettings.mtls.title')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('orgSecuritySettings.mtls.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleMtlsSave}
          disabled={mtlsSaving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {mtlsSaving ? t('common:states.saving') : t('orgSecuritySettings.mtls.actions.save')}
        </button>
      </div>

      {mtlsError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {mtlsError}
        </div>
      ) : null}

      {mtlsSuccess ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {t('orgSecuritySettings.mtls.saved')}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Fingerprint className="h-4 w-4" />
            {t('orgSecuritySettings.mtls.lifetime.title')}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('orgSecuritySettings.mtls.lifetime.label')}</label>
            <input
              type="number"
              min={1}
              max={365}
              value={certLifetimeDays}
              onChange={event => {
                const val = Number(event.target.value);
                setCertLifetimeDays(Math.max(1, Math.min(365, val || 90)));
                markDirty();
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('orgSecuritySettings.mtls.lifetime.description')}
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            {t('orgSecuritySettings.mtls.expiredPolicy.title')}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('orgSecuritySettings.mtls.expiredPolicy.label')}</label>
            <select
              value={expiredCertPolicy}
              onChange={event => {
                setExpiredCertPolicy(event.target.value as 'auto_reissue' | 'quarantine');
                markDirty();
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="auto_reissue">{t('orgSecuritySettings.mtls.expiredPolicy.autoReissue')}</option>
              <option value="quarantine">{t('orgSecuritySettings.mtls.expiredPolicy.quarantine')}</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            {expiredCertPolicy === 'auto_reissue'
              ? t('orgSecuritySettings.mtls.expiredPolicy.autoReissueDescription')
              : t('orgSecuritySettings.mtls.expiredPolicy.quarantineDescription')}
          </p>
        </div>
      </div>
    </section>
  );
}
