import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';

const softwareRuleSchema = z.object({
  name: z.string().min(1, 'Software name is required').max(500),
  vendor: z.string().max(200).optional().or(z.literal('')),
  minVersion: z.string().max(100).optional().or(z.literal('')),
  maxVersion: z.string().max(100).optional().or(z.literal('')),
  reason: z.string().max(1000).optional().or(z.literal('')),
});

const policyFormSchema = z.object({
  name: z.string().min(1, 'Policy name is required').max(200),
  description: z.string().max(4000).optional().or(z.literal('')),
  mode: z.enum(['allowlist', 'blocklist', 'audit']),
  software: z.array(softwareRuleSchema).min(1, 'At least one software rule is required'),
  allowUnknown: z.boolean().optional(),
  enforceMode: z.boolean(),
  autoUninstall: z.boolean().optional(),
  gracePeriod: z.coerce.number().int().min(0).max(2160).optional(),
});

export type PolicyFormValues = z.infer<typeof policyFormSchema>;

type PolicyFormProps = {
  onSubmit?: (values: PolicyFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<PolicyFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

export default function PolicyForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save Policy',
  loading,
}: PolicyFormProps) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PolicyFormValues>({
    resolver: zodResolver(policyFormSchema) as never,
    defaultValues: {
      name: '',
      description: '',
      mode: 'blocklist',
      software: [{ name: '', vendor: '', minVersion: '', maxVersion: '', reason: '' }],
      allowUnknown: false,
      enforceMode: false,
      autoUninstall: false,
      gracePeriod: 24,
      ...defaultValues,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'software',
  });

  const watchMode = watch('mode');
  const watchEnforceMode = watch('enforceMode');

  const isLoading = loading ?? isSubmitting;

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        await onSubmit?.(values);
      })}
      className="space-y-4"
    >
      {/* Basic Info */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="policy-name" className="text-sm font-medium">
            Policy Name
          </label>
          <input
            id="policy-name"
            placeholder="e.g. Block Unauthorized Software"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="policy-mode" className="text-sm font-medium">
            Mode
          </label>
          <select
            id="policy-mode"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('mode')}
          >
            <option value="blocklist">Blocklist</option>
            <option value="allowlist">Allowlist</option>
            <option value="audit">Audit Only</option>
          </select>
        </div>

        <div className="space-y-1 md:col-span-2">
          <label htmlFor="policy-description" className="text-sm font-medium">
            Description
          </label>
          <input
            id="policy-description"
            placeholder="Describe the purpose of this policy..."
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('description')}
          />
        </div>
      </div>

      {/* Software Rules */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Software Rules
            <span className="ml-2 font-normal text-xs text-muted-foreground">
              ({watchMode === 'allowlist' ? 'allow' : watchMode === 'blocklist' ? 'block' : 'audit'})
            </span>
          </h3>
          <button
            type="button"
            onClick={() => append({ name: '', vendor: '', minVersion: '', maxVersion: '', reason: '' })}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        </div>

        {errors.software?.root && (
          <p className="text-xs text-destructive">{errors.software.root.message}</p>
        )}

        {fields.length > 0 ? (
          <div className="space-y-2">
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
                <div className="flex-1 grid gap-2 sm:grid-cols-2 md:grid-cols-5">
                  <input
                    placeholder="Name *"
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.name`)}
                  />
                  <input
                    placeholder="Vendor"
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.vendor`)}
                  />
                  <input
                    placeholder="Min ver"
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.minVersion`)}
                  />
                  <input
                    placeholder="Max ver"
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.maxVersion`)}
                  />
                  <input
                    placeholder="Reason"
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.reason`)}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  disabled={fields.length <= 1}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-30"
                  title="Remove rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {errors.software && !errors.software.root && fields.some((_, i) => errors.software?.[i]?.name) && (
              <p className="text-xs text-destructive">Software name is required for all rules</p>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-center">
            <p className="text-sm text-muted-foreground">
              No software rules defined. Click "Add" to create one.
            </p>
          </div>
        )}

        {watchMode === 'allowlist' && (
          <label className="flex items-center gap-2 px-1">
            <input type="checkbox" className="h-4 w-4 rounded border-gray-300" {...register('allowUnknown')} />
            <span className="text-sm">Allow unknown software (not in the allowlist)</span>
          </label>
        )}
      </div>

      {/* Policy Settings */}
      <div className="rounded-md border bg-muted/20 p-3 space-y-3">
        <h3 className="text-sm font-semibold">Policy Settings</h3>
        <p className="text-xs text-muted-foreground">
          Assign this policy to devices via Configuration Policies.
        </p>
        <div className="grid gap-3 md:grid-cols-2 items-center">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 rounded border-gray-300" {...register('enforceMode')} />
            <span className="text-sm">Enforce (auto-remediate)</span>
          </label>

          {watchEnforceMode && (
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 rounded border-gray-300" {...register('autoUninstall')} />
              <span className="text-sm">Auto-uninstall</span>
            </label>
          )}
        </div>

        {watchEnforceMode && (
          <div className="flex items-center gap-3">
            <label htmlFor="grace-period" className="text-xs font-medium text-muted-foreground shrink-0">
              Grace Period (hours)
            </label>
            <input
              id="grace-period"
              type="number"
              min={0}
              max={2160}
              className="h-9 w-24 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('gracePeriod')}
            />
            <span className="text-xs text-muted-foreground">Max 2160h</span>
          </div>
        )}
      </div>

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
