import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

// Derive a URL-safe slug from an organization name. Matches the slug schema
// (^[a-z0-9-]+$) and the existing setup-wizard slugify behavior.
export function slugifyOrganizationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

const createOrganizationSchema = (t: (key: string) => string) => z
  .object({
    name: z.string().min(1, t('organizationForm.validation.nameRequired')),
    slug: z
      .string()
      .min(2, t('organizationForm.validation.slugRequired'))
      .regex(/^[a-z0-9-]+$/, t('organizationForm.validation.slugFormat')),
    type: z.enum(['customer', 'internal']),
    status: z.enum(['active', 'trial', 'suspended', 'churned']),
    maxDevices: z.coerce
      .number({ error: t('organizationForm.validation.maxDevicesRequired') })
      .int(t('organizationForm.validation.maxDevicesInteger'))
      .min(1, t('organizationForm.validation.maxDevicesMin')),
    contractStart: z.string().optional(),
    contractEnd: z.string().optional()
  })
  .refine(
    values => {
      if (!values.contractStart || !values.contractEnd) {
        return true;
      }

      return new Date(values.contractEnd) >= new Date(values.contractStart);
    },
    {
      message: t('organizationForm.validation.contractEndAfterStart'),
      path: ['contractEnd']
    }
  );

type OrganizationFormValues = z.infer<ReturnType<typeof createOrganizationSchema>>;

type OrganizationFormProps = {
  onSubmit?: (values: OrganizationFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<OrganizationFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const typeOptions = [
  { value: 'customer', labelKey: 'organizationForm.type.customer' },
  { value: 'internal', labelKey: 'organizationForm.type.internal' }
];

const statusOptions = [
  { value: 'active', labelKey: 'organizationForm.status.active' },
  { value: 'trial', labelKey: 'organizationForm.status.trial' },
  { value: 'suspended', labelKey: 'organizationForm.status.suspended' },
  { value: 'churned', labelKey: 'organizationForm.status.churned' }
];

export default function OrganizationForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading
}: OrganizationFormProps) {
  const { t } = useTranslation('settings');
  const organizationSchema = useMemo(() => createOrganizationSchema(t), [t]);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<z.input<typeof organizationSchema>, unknown, z.output<typeof organizationSchema>>({
    resolver: zodResolver(organizationSchema),
    defaultValues: {
      name: '',
      slug: '',
      type: 'customer',
      status: 'active',
      maxDevices: 50,
      contractStart: '',
      contractEnd: '',
      ...defaultValues
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const resolvedSubmitLabel = submitLabel ?? t('organizationForm.actions.save');

  // Keep the slug linked to the name until the user manually edits the slug.
  // If the form was seeded with an existing slug (edit mode), treat it as
  // already manually set so we never overwrite it.
  const slugManuallyEdited = useRef<boolean>(Boolean(defaultValues?.slug));

  const nameField = register('name');
  const slugField = register('slug');

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="organization-name" className="text-sm font-medium">
            {t('organizationForm.fields.name')}
          </label>
          <input
            id="organization-name"
            placeholder={t('organizationForm.placeholders.name')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...nameField}
            onChange={event => {
              nameField.onChange(event);
              if (!slugManuallyEdited.current) {
                setValue('slug', slugifyOrganizationName(event.target.value), {
                  shouldValidate: true
                });
              }
            }}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="organization-slug" className="text-sm font-medium">
            {t('organizationForm.fields.slug')}
          </label>
          <input
            id="organization-slug"
            placeholder={t('organizationForm.placeholders.slug')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...slugField}
            onChange={event => {
              // Once the user touches the slug, stop syncing it from the name.
              slugManuallyEdited.current = true;
              slugField.onChange(event);
            }}
          />
          {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="organization-type" className="text-sm font-medium">
            {t('organizationForm.fields.type')}
          </label>
          <select
            id="organization-type"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('type')}
          >
            {typeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          {errors.type && <p className="text-sm text-destructive">{errors.type.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="organization-status" className="text-sm font-medium">
            {t('common:labels.status')}
          </label>
          <select
            id="organization-status"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('status')}
          >
            {statusOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          {errors.status && <p className="text-sm text-destructive">{errors.status.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="max-devices" className="text-sm font-medium">
            {t('organizationForm.fields.maxDevices')}
          </label>
          <input
            id="max-devices"
            type="number"
            min={1}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('maxDevices')}
          />
          {errors.maxDevices && (
            <p className="text-sm text-destructive">{errors.maxDevices.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="contract-start" className="text-sm font-medium">
            {t('organizationForm.fields.contractStart')}
          </label>
          <input
            id="contract-start"
            type="date"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('contractStart')}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="contract-end" className="text-sm font-medium">
            {t('organizationForm.fields.contractEnd')}
          </label>
          <input
            id="contract-end"
            type="date"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('contractEnd')}
          />
          {errors.contractEnd && (
            <p className="text-sm text-destructive">{errors.contractEnd.message}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
        >
          {t('common:actions.cancel')}
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? t('common:states.saving') : resolvedSubmitLabel}
        </button>
      </div>
    </form>
  );
}
