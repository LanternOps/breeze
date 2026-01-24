import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const organizationSchema = z
  .object({
    name: z.string().min(1, 'Organization name is required'),
    slug: z
      .string()
      .min(2, 'Slug is required')
      .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and hyphens only'),
    type: z.enum(['customer', 'internal']),
    status: z.enum(['active', 'trial', 'suspended', 'churned']),
    maxDevices: z.coerce
      .number({ invalid_type_error: 'Enter a max device limit' })
      .int('Max devices must be a whole number')
      .min(1, 'Max devices must be at least 1'),
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
      message: 'Contract end must be on or after start date',
      path: ['contractEnd']
    }
  );

type OrganizationFormValues = z.infer<typeof organizationSchema>;

type OrganizationFormProps = {
  onSubmit?: (values: OrganizationFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<OrganizationFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const typeOptions = [
  { value: 'customer', label: 'Customer' },
  { value: 'internal', label: 'Internal' }
];

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'trial', label: 'Trial' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'churned', label: 'Churned' }
];

export default function OrganizationForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save organization',
  loading
}: OrganizationFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<OrganizationFormValues>({
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

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="organization-name" className="text-sm font-medium">
            Organization name
          </label>
          <input
            id="organization-name"
            placeholder="Acme Corp"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="organization-slug" className="text-sm font-medium">
            Slug
          </label>
          <input
            id="organization-slug"
            placeholder="acme-corp"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('slug')}
          />
          {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="organization-type" className="text-sm font-medium">
            Organization type
          </label>
          <select
            id="organization-type"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('type')}
          >
            {typeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {errors.type && <p className="text-sm text-destructive">{errors.type.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="organization-status" className="text-sm font-medium">
            Status
          </label>
          <select
            id="organization-status"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('status')}
          >
            {statusOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {errors.status && <p className="text-sm text-destructive">{errors.status.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="max-devices" className="text-sm font-medium">
            Max devices
          </label>
          <input
            id="max-devices"
            type="number"
            min={1}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('maxDevices')}
          />
          {errors.maxDevices && (
            <p className="text-sm text-destructive">{errors.maxDevices.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="contract-start" className="text-sm font-medium">
            Contract start
          </label>
          <input
            id="contract-start"
            type="date"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('contractStart')}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="contract-end" className="text-sm font-medium">
            Contract end
          </label>
          <input
            id="contract-end"
            type="date"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
