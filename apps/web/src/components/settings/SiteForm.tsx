import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

// Only `name` is required server-side (timezone defaults to 'UTC' in the API).
// The empty-string branch on contactEmail is load-bearing: react-hook-form
// sends `''` for unfilled inputs, so `z.string().email().optional()` alone
// would block submit on a name-only form.
const createSiteSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('siteForm.validation.nameRequired')),
  timezone: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  contactName: z.string().optional(),
  contactEmail: z.union([z.string().email(t('siteForm.validation.email')), z.literal('')]).optional(),
  contactPhone: z.string().optional()
});

type SiteFormValues = z.infer<ReturnType<typeof createSiteSchema>>;

type SiteFormProps = {
  onSubmit?: (values: SiteFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<SiteFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const timezoneOptions = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney'
];

export default function SiteForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading
}: SiteFormProps) {
  const { t } = useTranslation('settings');
  const siteSchema = useMemo(() => createSiteSchema(t), [t]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<SiteFormValues>({
    resolver: zodResolver(siteSchema),
    defaultValues: {
      name: '',
      timezone: 'UTC',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      postalCode: '',
      country: '',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
      ...defaultValues
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const resolvedSubmitLabel = submitLabel ?? t('siteForm.actions.save');

  // Ensure the selected/default timezone is always a real <option>, otherwise a
  // native select silently falls back to its first option (e.g. a partner tz
  // like "Europe/Paris" that isn't in the short list above).
  const zones = useMemo(() => {
    const selected = defaultValues?.timezone;
    return selected && !timezoneOptions.includes(selected)
      ? [selected, ...timezoneOptions]
      : timezoneOptions;
  }, [defaultValues?.timezone]);

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <p className="text-sm text-muted-foreground">
        {t('siteForm.description')}
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="site-name" className="text-sm font-medium">
            {t('siteForm.fields.name')}
          </label>
          <input
            id="site-name"
            placeholder={t('siteForm.placeholders.name')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="site-timezone" className="text-sm font-medium">
            {t('siteForm.fields.timezone')}
          </label>
          <select
            id="site-timezone"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('timezone')}
          >
            {zones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          {errors.timezone && (
            <p className="text-sm text-destructive">{errors.timezone.message}</p>
          )}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="address-line-1" className="text-sm font-medium">
            {t('siteForm.fields.addressLine1')}
          </label>
          <input
            id="address-line-1"
            placeholder={t('siteForm.placeholders.addressLine1')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('addressLine1')}
          />
          {errors.addressLine1 && (
            <p className="text-sm text-destructive">{errors.addressLine1.message}</p>
          )}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="address-line-2" className="text-sm font-medium">
            {t('siteForm.fields.addressLine2')}
          </label>
          <input
            id="address-line-2"
            placeholder={t('siteForm.placeholders.addressLine2')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('addressLine2')}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="city" className="text-sm font-medium">
            {t('siteForm.fields.city')}
          </label>
          <input
            id="city"
            placeholder={t('siteForm.placeholders.city')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('city')}
          />
          {errors.city && <p className="text-sm text-destructive">{errors.city.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="state" className="text-sm font-medium">
            {t('siteForm.fields.state')}
          </label>
          <input
            id="state"
            placeholder={t('siteForm.placeholders.state')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('state')}
          />
          {errors.state && <p className="text-sm text-destructive">{errors.state.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="postal-code" className="text-sm font-medium">
            {t('siteForm.fields.postalCode')}
          </label>
          <input
            id="postal-code"
            placeholder={t('siteForm.placeholders.postalCode')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('postalCode')}
          />
          {errors.postalCode && (
            <p className="text-sm text-destructive">{errors.postalCode.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="country" className="text-sm font-medium">
            {t('siteForm.fields.country')}
          </label>
          <input
            id="country"
            placeholder={t('siteForm.placeholders.country')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('country')}
          />
          {errors.country && (
            <p className="text-sm text-destructive">{errors.country.message}</p>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">{t('siteForm.primaryContact')}</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="contact-name" className="text-sm font-medium">
              {t('common:labels.name')}
            </label>
            <input
              id="contact-name"
              placeholder={t('siteForm.placeholders.contactName')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('contactName')}
            />
            {errors.contactName && (
              <p className="text-sm text-destructive">{errors.contactName.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="contact-email" className="text-sm font-medium">
              {t('siteForm.fields.email')}
            </label>
            <input
              id="contact-email"
              type="email"
              placeholder={t('siteForm.placeholders.contactEmail')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('contactEmail')}
            />
            {errors.contactEmail && (
              <p className="text-sm text-destructive">{errors.contactEmail.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="contact-phone" className="text-sm font-medium">
              {t('siteForm.fields.phone')}
            </label>
            <input
              id="contact-phone"
              placeholder={t('siteForm.placeholders.contactPhone')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('contactPhone')}
            />
            {errors.contactPhone && (
              <p className="text-sm text-destructive">{errors.contactPhone.message}</p>
            )}
          </div>
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
