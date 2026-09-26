import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import OrgAccessFields from './OrgAccessFields';

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

  const selectedOrgIds = useMemo(
    () => (orgIdsValue ?? '').split(',').map(s => s.trim()).filter(Boolean),
    [orgIdsValue]
  );

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
            <OrgAccessFields
              idPrefix="invite"
              orgAccess={orgAccessValue ?? 'all'}
              orgIds={selectedOrgIds}
              organizations={organizations}
              onChange={(access, ids) => {
                if (access !== orgAccessValue) {
                  setValue('orgAccess', access);
                }
                if (ids !== selectedOrgIds) {
                  setValue('orgIds', ids.join(','), { shouldValidate: true });
                }
              }}
              orgIdsError={errors.orgIds?.message}
            />
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
