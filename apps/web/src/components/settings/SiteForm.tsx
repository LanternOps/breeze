import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const siteSchema = z.object({
  name: z.string().min(1, 'Site name is required'),
  timezone: z.string().min(1, 'Timezone is required'),
  addressLine1: z.string().min(1, 'Address line 1 is required'),
  addressLine2: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State/Region is required'),
  postalCode: z.string().min(1, 'Postal code is required'),
  country: z.string().min(1, 'Country is required'),
  contactName: z.string().min(1, 'Contact name is required'),
  contactEmail: z.string().email('Enter a valid email address'),
  contactPhone: z.string().min(7, 'Enter a phone number')
});

type SiteFormValues = z.infer<typeof siteSchema>;

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
  submitLabel = 'Save site',
  loading
}: SiteFormProps) {
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

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="site-name" className="text-sm font-medium">
            Site name
          </label>
          <input
            id="site-name"
            placeholder="Headquarters"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="site-timezone" className="text-sm font-medium">
            Timezone
          </label>
          <select
            id="site-timezone"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('timezone')}
          >
            {timezoneOptions.map(zone => (
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
            Address line 1
          </label>
          <input
            id="address-line-1"
            placeholder="123 Market Street"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('addressLine1')}
          />
          {errors.addressLine1 && (
            <p className="text-sm text-destructive">{errors.addressLine1.message}</p>
          )}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="address-line-2" className="text-sm font-medium">
            Address line 2
          </label>
          <input
            id="address-line-2"
            placeholder="Suite 500"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('addressLine2')}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="city" className="text-sm font-medium">
            City
          </label>
          <input
            id="city"
            placeholder="San Francisco"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('city')}
          />
          {errors.city && <p className="text-sm text-destructive">{errors.city.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="state" className="text-sm font-medium">
            State/Region
          </label>
          <input
            id="state"
            placeholder="CA"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('state')}
          />
          {errors.state && <p className="text-sm text-destructive">{errors.state.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="postal-code" className="text-sm font-medium">
            Postal code
          </label>
          <input
            id="postal-code"
            placeholder="94107"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('postalCode')}
          />
          {errors.postalCode && (
            <p className="text-sm text-destructive">{errors.postalCode.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="country" className="text-sm font-medium">
            Country
          </label>
          <input
            id="country"
            placeholder="United States"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('country')}
          />
          {errors.country && (
            <p className="text-sm text-destructive">{errors.country.message}</p>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">Primary contact</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="contact-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="contact-name"
              placeholder="Alex Morgan"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('contactName')}
            />
            {errors.contactName && (
              <p className="text-sm text-destructive">{errors.contactName.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="contact-email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="contact-email"
              type="email"
              placeholder="alex@company.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('contactEmail')}
            />
            {errors.contactEmail && (
              <p className="text-sm text-destructive">{errors.contactEmail.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="contact-phone" className="text-sm font-medium">
              Phone
            </label>
            <input
              id="contact-phone"
              placeholder="+1 (555) 123-4567"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
