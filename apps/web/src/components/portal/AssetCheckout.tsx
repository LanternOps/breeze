import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const assetCheckoutSchema = z.object({
  expectedReturnDate: z.string().min(1, 'Select an expected return date'),
  notes: z.string().optional()
});

type AssetCheckoutValues = z.infer<typeof assetCheckoutSchema>;

type AssetCheckoutProps = {
  assetName?: string;
  onSubmit?: (values: AssetCheckoutValues) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

export default function AssetCheckout({
  assetName,
  onSubmit,
  errorMessage,
  submitLabel = 'Request checkout',
  loading
}: AssetCheckoutProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<AssetCheckoutValues>({
    resolver: zodResolver(assetCheckoutSchema),
    defaultValues: {
      expectedReturnDate: '',
      notes: ''
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
      <div>
        <h2 className="text-sm font-semibold text-foreground">Asset checkout</h2>
        {assetName && (
          <p className="text-xs text-muted-foreground">Requesting: {assetName}</p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="expectedReturnDate" className="text-sm font-medium">
          Expected return date
        </label>
        <input
          id="expectedReturnDate"
          type="date"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('expectedReturnDate')}
        />
        {errors.expectedReturnDate && (
          <p className="text-sm text-destructive">{errors.expectedReturnDate.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="notes" className="text-sm font-medium">
          Notes (optional)
        </label>
        <textarea
          id="notes"
          rows={3}
          placeholder="Add any pickup or delivery details"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('notes')}
        />
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? 'Submitting request...' : submitLabel}
      </button>
    </form>
  );
}
