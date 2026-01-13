import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Confirm your new password')
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  })
  .refine(data => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from current password',
    path: ['newPassword']
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

type ChangePasswordFormProps = {
  onSubmit?: (values: ChangePasswordFormValues) => void | Promise<void>;
  errorMessage?: string;
  successMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

type StrengthConfig = {
  label: string;
  className: string;
  minScore: number;
};

const strengthScale: StrengthConfig[] = [
  { label: 'Too weak', className: 'bg-destructive', minScore: 0 },
  { label: 'Weak', className: 'bg-destructive/70', minScore: 2 },
  { label: 'Fair', className: 'bg-amber-500', minScore: 3 },
  { label: 'Good', className: 'bg-emerald-500', minScore: 4 },
  { label: 'Strong', className: 'bg-emerald-600', minScore: 5 }
];

function getStrengthScore(password: string) {
  let score = 0;

  if (password.length >= 8) {
    score += 1;
  }
  if (/[A-Z]/.test(password)) {
    score += 1;
  }
  if (/[a-z]/.test(password)) {
    score += 1;
  }
  if (/\d/.test(password)) {
    score += 1;
  }
  if (/[^A-Za-z0-9]/.test(password)) {
    score += 1;
  }

  return score;
}

export default function ChangePasswordForm({
  onSubmit,
  errorMessage,
  successMessage,
  submitLabel = 'Change password',
  loading
}: ChangePasswordFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const newPasswordValue = watch('newPassword');

  const strength = useMemo(() => {
    if (!newPasswordValue) {
      return {
        label: 'Enter a password',
        className: 'bg-muted',
        percent: 0
      };
    }

    const score = getStrengthScore(newPasswordValue);
    const tier = strengthScale
      .slice()
      .reverse()
      .find(item => score >= item.minScore);
    const percent = Math.min(100, Math.round((score / 5) * 100));
    const defaultTier = { label: 'Weak', className: 'bg-destructive', minScore: 0 };

    return {
      label: tier?.label ?? defaultTier.label,
      className: tier?.className ?? defaultTier.className,
      percent
    };
  }, [newPasswordValue]);

  const handleFormSubmit = async (values: ChangePasswordFormValues) => {
    await onSubmit?.(values);
    reset();
  };

  return (
    <form
      onSubmit={handleSubmit(handleFormSubmit)}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Change password</h2>
        <p className="text-sm text-muted-foreground">
          Update your password to keep your account secure.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="currentPassword" className="text-sm font-medium">
          Current password
        </label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          placeholder="Enter your current password"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('currentPassword')}
        />
        {errors.currentPassword && (
          <p className="text-sm text-destructive">{errors.currentPassword.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="newPassword" className="text-sm font-medium">
          New password
        </label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          placeholder="Create a new password"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('newPassword')}
        />
        {errors.newPassword && (
          <p className="text-sm text-destructive">{errors.newPassword.message}</p>
        )}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Password strength</span>
            <span>{strength.label}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all ${strength.className}`}
              style={{ width: `${strength.percent}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter your new password"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p className="text-sm text-destructive">{errors.confirmPassword.message}</p>
        )}
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
          {successMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? 'Changing password...' : submitLabel}
      </button>
    </form>
  );
}
