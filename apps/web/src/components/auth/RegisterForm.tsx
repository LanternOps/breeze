import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const registerSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Confirm your password')
  })
  .refine(data => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  });

type RegisterFormValues = z.infer<typeof registerSchema>;

type RegisterFormProps = {
  onSubmit?: (values: RegisterFormValues) => void | Promise<void>;
  errorMessage?: string;
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

export default function RegisterForm({
  onSubmit,
  errorMessage,
  submitLabel = 'Create account',
  loading
}: RegisterFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const passwordValue = watch('password');

  const strength = useMemo(() => {
    if (!passwordValue) {
      return {
        label: 'Enter a password',
        className: 'bg-muted',
        percent: 0
      };
    }

    const score = getStrengthScore(passwordValue);
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
  }, [passwordValue]);

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="space-y-2">
        <label htmlFor="name" className="text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          placeholder="Jane Doe"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('name')}
        />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('email')}
        />
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder="Create a password"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-sm text-destructive">{errors.password.message}</p>
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
          Confirm password
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter your password"
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

      <button
        type="submit"
        disabled={isLoading}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? 'Creating account...' : submitLabel}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <a href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </a>
      </p>
    </form>
  );
}
