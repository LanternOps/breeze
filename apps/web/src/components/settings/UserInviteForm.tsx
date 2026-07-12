import { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const createInviteSchema = (t: (key: string) => string) => z
  .object({
    email: z.string().email(t('userInviteForm.validation.email')),
    name: z.string().min(1, t('userInviteForm.validation.nameRequired')).max(255),
    roleId: z.string().min(1, t('userInviteForm.validation.roleRequired')),
    orgAccess: z.enum(['all', 'selected', 'none']).optional(),
    orgIds: z.string().optional()
  })
  .superRefine((data, ctx) => {
    if (data.orgAccess === 'selected' && !data.orgIds?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgIds'],
        message: t('userInviteForm.validation.orgRequired')
      });
    }
  });

type InviteFormValues = z.infer<ReturnType<typeof createInviteSchema>>;

export type RoleOption = {
  id: string;
  name: string;
  scope: string;
};

type OrgOption = {
  id: string;
  name: string;
};

type UserInviteFormProps = {
  isOpen?: boolean;
  roles?: RoleOption[];
  organizations?: OrgOption[];
  onSubmit?: (values: InviteFormValues) => void | Promise<void>;
  onCancel?: () => void;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
  title?: string;
  description?: string;
  showOrgAccess?: boolean;
};

export default function UserInviteForm({
  isOpen = true,
  roles = [],
  organizations = [],
  onSubmit,
  onCancel,
  errorMessage,
  submitLabel,
  loading,
  title,
  description,
  showOrgAccess = false
}: UserInviteFormProps) {
  const { t } = useTranslation('settings');
  const inviteSchema = useMemo(() => createInviteSchema(t), [t]);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: '',
      name: '',
      roleId: roles[0]?.id ?? '',
      orgAccess: 'all',
      orgIds: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const resolvedTitle = title ?? t('userInviteForm.title');
  const resolvedDescription = description ?? t('userInviteForm.description');
  const resolvedSubmitLabel = submitLabel ?? t('userInviteForm.actions.sendInvite');
  const orgAccessValue = watch('orgAccess');
  const orgIdsValue = watch('orgIds');
  const showOrgSettings = showOrgAccess && orgAccessValue !== undefined;

  // Org search state
  const [orgSearch, setOrgSearch] = useState('');
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const orgSearchRef = useRef<HTMLInputElement>(null);
  const orgDropdownRef = useRef<HTMLDivElement>(null);

  const selectedOrgIds = useMemo(
    () => (orgIdsValue ?? '').split(',').map(s => s.trim()).filter(Boolean),
    [orgIdsValue]
  );

  const filteredOrgs = useMemo(
    () =>
      organizations.filter(
        org =>
          !selectedOrgIds.includes(org.id) &&
          org.name.toLowerCase().includes(orgSearch.toLowerCase())
      ),
    [organizations, selectedOrgIds, orgSearch]
  );

  const addOrg = (orgId: string) => {
    const next = [...selectedOrgIds, orgId].join(',');
    setValue('orgIds', next, { shouldValidate: true });
    setOrgSearch('');
    setOrgDropdownOpen(false);
    orgSearchRef.current?.focus();
  };

  const removeOrg = (orgId: string) => {
    const next = selectedOrgIds.filter(id => id !== orgId).join(',');
    setValue('orgIds', next, { shouldValidate: true });
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (orgDropdownRef.current && !orgDropdownRef.current.contains(e.target as Node)) {
        setOrgDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{resolvedTitle}</h2>
          <p className="text-sm text-muted-foreground">{resolvedDescription}</p>
        </div>

        <form
          onSubmit={handleSubmit(async values => {
            await onSubmit?.(values);
          })}
          className="mt-6 space-y-5"
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="invite-name" className="text-sm font-medium">
                {t('common:labels.name')}
              </label>
              <input
                id="invite-name"
                type="text"
                autoComplete="name"
                placeholder={t('userInviteForm.placeholders.name')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="invite-email" className="text-sm font-medium">
                {t('userInviteForm.fields.email')}
              </label>
              <input
                id="invite-email"
                type="email"
                autoComplete="email"
                placeholder={t('userInviteForm.placeholders.email')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('email')}
              />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="invite-role" className="text-sm font-medium">
              {t('userInviteForm.fields.role')}
            </label>
            <select
              id="invite-role"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('roleId')}
            >
              {roles.map(role => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
            {errors.roleId && <p className="text-sm text-destructive">{errors.roleId.message}</p>}
          </div>

          {showOrgSettings && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-4">
              <div>
                <h3 className="text-sm font-semibold">{t('userInviteForm.orgAccess.title')}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('userInviteForm.orgAccess.description')}
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="invite-access" className="text-sm font-medium">
                  {t('userInviteForm.orgAccess.level')}
                </label>
                <select
                  id="invite-access"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('orgAccess')}
                >
                  <option value="all">{t('userInviteForm.orgAccess.all')}</option>
                  <option value="selected">{t('userInviteForm.orgAccess.selected')}</option>
                  <option value="none">{t('userInviteForm.orgAccess.none')}</option>
                </select>
                {errors.orgAccess && (
                  <p className="text-sm text-destructive">{errors.orgAccess.message}</p>
                )}
              </div>
              {orgAccessValue === 'selected' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('userInviteForm.orgAccess.organizations')}
                  </label>
                  {/* Selected org chips */}
                  {selectedOrgIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedOrgIds.map(id => {
                        const org = organizations.find(o => o.id === id);
                        return (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                          >
                            {org?.name ?? id}
                            <button
                              type="button"
                              onClick={() => removeOrg(id)}
                              className="ml-0.5 rounded-sm hover:text-destructive"
                              aria-label={t('userInviteForm.orgAccess.removeOrg', { name: org?.name ?? id })}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                              </svg>
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Search input + dropdown */}
                  <div ref={orgDropdownRef} className="relative">
                    <input
                      ref={orgSearchRef}
                      type="text"
                      value={orgSearch}
                      onChange={e => {
                        setOrgSearch(e.target.value);
                        setOrgDropdownOpen(true);
                      }}
                      onFocus={() => setOrgDropdownOpen(true)}
                      placeholder={t('userInviteForm.orgAccess.searchPlaceholder')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    {orgDropdownOpen && (
                      <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-card shadow-md">
                        {filteredOrgs.length === 0 ? (
                          <p className="px-3 py-2 text-sm text-muted-foreground">
                            {organizations.length === 0
                              ? t('userInviteForm.orgAccess.noOrganizations')
                              : t('userInviteForm.orgAccess.noMatches')}
                          </p>
                        ) : (
                          filteredOrgs.map(org => (
                            <button
                              key={org.id}
                              type="button"
                              onClick={() => addOrg(org.id)}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                            >
                              {org.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  {/* Hidden field for form state */}
                  <input type="hidden" {...register('orgIds')} />
                  {errors.orgIds && (
                    <p className="text-sm text-destructive">{errors.orgIds.message}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => onCancel?.()}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? t('userInviteForm.actions.sending') : resolvedSubmitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
