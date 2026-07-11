import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useMemo, useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const ssoProviderSchema = z.object({
  name: z.string().min(1, i18n.t('settings:ssoProviderForm.providerNameIsRequired')),
  type: z.enum(['oidc', 'saml']),
  // Ownership axis (#2183, mirrors software policies #2126): 'partner' = a
  // partner-wide provider used for technician login. Surfaced on create only,
  // for partner-scope users (showOwnerScope); the server derives the partner
  // from the caller's own token. Update schema omits it (create-only).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  preset: z.string().optional(),
  issuer: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
  attributeMapping: z.object({
    email: z.string().min(1, i18n.t('settings:ssoProviderForm.emailAttributeIsRequired')),
    name: z.string().min(1, i18n.t('settings:ssoProviderForm.nameAttributeIsRequired')),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    groups: z.string().optional()
  }),
  autoProvision: z.boolean(),
  defaultRoleId: z.string().optional(),
  allowedDomains: z.string().optional(),
  enforceSSO: z.boolean()
});

export type SsoProviderFormValues = z.infer<typeof ssoProviderSchema>;

export type ProviderPreset = {
  id: string;
  name: string;
  scopes: string;
  attributeMapping: {
    email: string;
    name: string;
    firstName?: string;
    lastName?: string;
    groups?: string;
  };
};

export type Role = {
  id: string;
  name: string;
  // Present on roles fetched from /roles. Used to filter the default-role
  // dropdown by the selected ownership scope (partner vs organization).
  scope?: 'partner' | 'organization';
};

type SsoProviderFormProps = {
  onSubmit?: (values: SsoProviderFormValues) => void | Promise<void>;
  onCancel?: () => void;
  onTestConnection?: () => void;
  defaultValues?: Partial<SsoProviderFormValues>;
  presets?: ProviderPreset[];
  roles?: Role[];
  submitLabel?: string;
  loading?: boolean;
  testingConnection?: boolean;
  isEditing?: boolean;
  hasClientSecret?: boolean;
  /** Show the ownership-scope selector (create-only, partner-scope users). */
  showOwnerScope?: boolean;
};

const presetOptions = [
  { value: '', label: i18n.t('settings:ssoProviderForm.customConfiguration') },
  { value: 'azure', label: i18n.t('settings:ssoProviderForm.azureADEntraID') },
  { value: 'okta', label: i18n.t('settings:ssoProviderForm.okta') },
  { value: 'google', label: i18n.t('settings:ssoProviderForm.googleWorkspace') },
  { value: 'auth0', label: i18n.t('settings:ssoProviderForm.auth0') }
];

export default function SsoProviderForm({
  onSubmit,
  onCancel,
  onTestConnection,
  defaultValues,
  presets = [],
  roles = [],
  submitLabel = 'Save provider',
  loading,
  testingConnection,
  isEditing,
  hasClientSecret,
  showOwnerScope = false
}: SsoProviderFormProps) {
  const { t } = useTranslation('settings');
  const [showSecret, setShowSecret] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setValue,
    control,
  } = useForm<SsoProviderFormValues>({
    resolver: zodResolver(ssoProviderSchema),
    defaultValues: {
      name: '',
      type: 'oidc',
      preset: '',
      issuer: '',
      clientId: '',
      clientSecret: '',
      scopes: 'openid profile email',
      attributeMapping: {
        email: 'email',
        name: 'name',
        firstName: '',
        lastName: '',
        groups: ''
      },
      autoProvision: true,
      defaultRoleId: '',
      allowedDomains: '',
      enforceSSO: false,
      ownerScope: 'organization',
      ...defaultValues
    }
  });

  const selectedPreset = useWatch({ control, name: 'preset' });
  const enforceSSO = useWatch({ control, name: 'enforceSSO' });
  const ownerScope = useWatch({ control, name: 'ownerScope' });

  // The default-role dropdown must offer roles that match the chosen ownership
  // scope: partner-wide providers auto-provision into PARTNER roles, org
  // providers into ORG roles. Roles carry `scope`; when it's absent (older
  // payloads) fall back to showing them under the organization scope.
  const visibleRoles = useMemo(() => {
    if (ownerScope === 'partner') return roles.filter(r => r.scope === 'partner');
    return roles.filter(r => r.scope !== 'partner');
  }, [roles, ownerScope]);

  // Apply preset configuration when preset changes
  useEffect(() => {
    if (selectedPreset && presets.length > 0) {
      const preset = presets.find(p => p.id === selectedPreset);
      if (preset) {
        setValue('scopes', preset.scopes);
        setValue('attributeMapping', preset.attributeMapping);
      }
    }
  }, [selectedPreset, presets, setValue]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Ownership scope — partner-scope creators only, create-only (#2183) */}
      {showOwnerScope && !isEditing && (
        <fieldset className="space-y-2 rounded-md border p-4" data-testid="sso-provider-owner">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('ssoProviderForm.appliesTo')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="organization"
              {...register('ownerScope')}
              data-testid="sso-provider-owner-org"
            />
            {t('ssoProviderForm.thisOrganization')}</label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="partner"
              {...register('ownerScope')}
              data-testid="sso-provider-owner-partner"
            />
            {t('ssoProviderForm.partnerTechnicianLogin')}{' '}
            <span className="text-muted-foreground">{t('ssoProviderForm.yourOwnTeamSignsInWithThis')}</span>
          </label>
        </fieldset>
      )}

      {/* Basic Information */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('ssoProviderForm.basicInformation')}</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="provider-name" className="text-sm font-medium">
              {t('ssoProviderForm.providerName')}</label>
            <input
              id="provider-name"
              placeholder={t('ssoProviderForm.eGOktaProduction')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('name')}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="provider-preset" className="text-sm font-medium">
              {t('ssoProviderForm.providerPreset')}</label>
            <select
              id="provider-preset"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('preset')}
            >
              {presetOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t('ssoProviderForm.selectAPresetToAutoFillRecommendedSettings')}</p>
          </div>
        </div>
      </div>

      {/* Connection Settings */}
      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('ssoProviderForm.connectionSettings')}</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label htmlFor="provider-issuer" className="text-sm font-medium">
              {t('ssoProviderForm.issuerURL')}</label>
            <input
              id="provider-issuer"
              type="url"
              placeholder={t('ssoProviderForm.httpsYourTenantOktaCom')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('issuer')}
            />
            {errors.issuer && <p className="text-sm text-destructive">{errors.issuer.message}</p>}
            <p className="text-xs text-muted-foreground">
              {t('ssoProviderForm.theOpenIDConnectDiscoveryURLWithoutWellKnownOpenidConfig')}</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="provider-client-id" className="text-sm font-medium">
              {t('ssoProviderForm.clientID')}</label>
            <input
              id="provider-client-id"
              placeholder={t('ssoProviderForm.yourClientId')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('clientId')}
            />
            {errors.clientId && <p className="text-sm text-destructive">{errors.clientId.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="provider-client-secret" className="text-sm font-medium">
              {t('ssoProviderForm.clientSecret')}{isEditing && hasClientSecret && (
                <span className="ml-2 text-xs text-muted-foreground">{t('ssoProviderForm.leaveBlankToKeepExisting')}</span>
              )}
            </label>
            <div className="relative">
              <input
                id="provider-client-secret"
                type={showSecret ? 'text' : 'password'}
                placeholder={isEditing && hasClientSecret ? '********' : 'your-client-secret'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('clientSecret')}
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showSecret ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
            {errors.clientSecret && <p className="text-sm text-destructive">{errors.clientSecret.message}</p>}
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="provider-scopes" className="text-sm font-medium">
              {t('ssoProviderForm.scopes')}</label>
            <input
              id="provider-scopes"
              placeholder={t('ssoProviderForm.openidProfileEmail')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('scopes')}
            />
            <p className="text-xs text-muted-foreground">
              {t('ssoProviderForm.spaceSeparatedListOfOAuthScopesToRequest')}</p>
          </div>
        </div>
      </div>

      {/* Attribute Mapping */}
      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('ssoProviderForm.attributeMapping')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('ssoProviderForm.mapIdentityProviderClaimsToUserAttributes')}</p>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="attr-email" className="text-sm font-medium">
              {t('ssoProviderForm.emailAttribute')}</label>
            <input
              id="attr-email"
              placeholder={t('ssoProviderForm.email')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('attributeMapping.email')}
            />
            {errors.attributeMapping?.email && (
              <p className="text-sm text-destructive">{errors.attributeMapping.email.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="attr-name" className="text-sm font-medium">
              {t('ssoProviderForm.displayNameAttribute')}</label>
            <input
              id="attr-name"
              placeholder={t('ssoProviderForm.name')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('attributeMapping.name')}
            />
            {errors.attributeMapping?.name && (
              <p className="text-sm text-destructive">{errors.attributeMapping.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="attr-first-name" className="text-sm font-medium">
              {t('ssoProviderForm.firstNameAttribute')}<span className="text-muted-foreground">{t('ssoProviderForm.optional')}</span>
            </label>
            <input
              id="attr-first-name"
              placeholder={t('ssoProviderForm.givenName')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('attributeMapping.firstName')}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="attr-last-name" className="text-sm font-medium">
              {t('ssoProviderForm.lastNameAttribute')}<span className="text-muted-foreground">{t('ssoProviderForm.optional')}</span>
            </label>
            <input
              id="attr-last-name"
              placeholder={t('ssoProviderForm.familyName')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('attributeMapping.lastName')}
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="attr-groups" className="text-sm font-medium">
              {t('ssoProviderForm.groupsAttribute')}<span className="text-muted-foreground">{t('ssoProviderForm.optional')}</span>
            </label>
            <input
              id="attr-groups"
              placeholder={t('ssoProviderForm.groups')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('attributeMapping.groups')}
            />
            <p className="text-xs text-muted-foreground">
              {t('ssoProviderForm.usedForGroupBasedRoleMappingIfSupportedByYourIdP')}</p>
          </div>
        </div>
      </div>

      {/* Provisioning Settings */}
      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('ssoProviderForm.userProvisioning')}</h3>
        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
              {...register('autoProvision')}
            />
            <div>
              <span className="text-sm font-medium">{t('ssoProviderForm.autoProvisionUsers')}</span>
              <p className="text-xs text-muted-foreground">
                {t('ssoProviderForm.automaticallyCreateUserAccountsWhenTheyFirstSignInViaSSO')}</p>
            </div>
          </label>

          <div className="space-y-2">
            <label htmlFor="default-role" className="text-sm font-medium">
              {t('ssoProviderForm.defaultRoleForNewUsers')}</label>
            <select
              id="default-role"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring md:w-1/2"
              {...register('defaultRoleId')}
            >
              <option value="">{t('ssoProviderForm.selectARole')}</option>
              {visibleRoles.map(role => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t('ssoProviderForm.roleAssignedToAutoProvisionedUsers')}</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="allowed-domains" className="text-sm font-medium">
              {t('ssoProviderForm.allowedEmailDomains')}</label>
            <input
              id="allowed-domains"
              placeholder={t('ssoProviderForm.exampleComCompanyOrg')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring md:w-1/2"
              {...register('allowedDomains')}
            />
            <p className="text-xs text-muted-foreground">
              {t('ssoProviderForm.commaSeparatedListOfAllowedEmailDomainsLeaveEmptyToAllow')}</p>
          </div>
        </div>
      </div>

      {/* Security Settings */}
      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('ssoProviderForm.securitySettings')}</h3>
        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
              {...register('enforceSSO')}
            />
            <div>
              <span className="text-sm font-medium">{t('ssoProviderForm.enforceSSOOnlyLogin')}</span>
              <p className="text-xs text-muted-foreground">
                {t('ssoProviderForm.usersMustUseSSOToSignInPasswordLoginWillBeDisabled')}</p>
            </div>
          </label>

          {enforceSSO && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
              <div className="flex gap-3">
                <svg
                  className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <h4 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {t('ssoProviderForm.warningSSOEnforcementEnabled')}</h4>
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                    {t('ssoProviderForm.usersWillNotBeAbleToSignInWithPasswordsMakeSureYourSSOCo')}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onTestConnection}
          disabled={testingConnection}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {testingConnection ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t('ssoProviderForm.testing')}</>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {t('ssoProviderForm.testConnection')}</>
          )}
        </button>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
          >
            {t('ssoProviderForm.cancel')}</button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {isLoading ? t('ssoProviderForm.saving') : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
