import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const accessReviewSchema = z.object({
  name: z.string().min(1, 'Review name is required').max(255),
  description: z.string().optional(),
  dueDate: z.string().optional()
});

type AccessReviewFormValues = z.infer<typeof accessReviewSchema>;

type AccessReviewFormProps = {
  isOpen: boolean;
  onSubmit?: (values: AccessReviewFormValues) => void | Promise<void>;
  onCancel?: () => void;
  loading?: boolean;
};

export default function AccessReviewForm({
  isOpen,
  onSubmit,
  onCancel,
  loading
}: AccessReviewFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset
  } = useForm<AccessReviewFormValues>({
    resolver: zodResolver(accessReviewSchema),
    defaultValues: {
      name: '',
      description: '',
      dueDate: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const handleClose = () => {
    reset();
    onCancel?.();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Create Access Review</h2>
          <p className="text-sm text-muted-foreground">
            Start a new access review to audit user permissions. This will generate review items for
            all users in scope.
          </p>
        </div>

        <form
          onSubmit={handleSubmit(async (values) => {
            await onSubmit?.(values);
          })}
          className="mt-6 space-y-5"
        >
          <div className="space-y-2">
            <label htmlFor="review-name" className="text-sm font-medium">
              Review Name
            </label>
            <input
              id="review-name"
              placeholder="Q1 2024 Access Review"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('name')}
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="review-description" className="text-sm font-medium">
              Description (optional)
            </label>
            <textarea
              id="review-description"
              placeholder="Describe the purpose of this access review..."
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              {...register('description')}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="review-due-date" className="text-sm font-medium">
              Due Date (optional)
            </label>
            <input
              id="review-due-date"
              type="date"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('dueDate')}
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? 'Creating...' : 'Create Review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
