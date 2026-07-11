import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { cn, widthPercentClass } from '@/lib/utils';

type RegisterFormValues = {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
};

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
  submitLabel,
  loading
}: RegisterFormProps) {
  const { t } = useTranslation('auth');
  const registerSchema = useMemo(
    () =>
      z
        .object({
          name: z.string().min(2, t('validation.nameMin', { defaultValue: 'Name must be at least 2 characters' })),
          email: z.string().email(t('validation.email', { defaultValue: 'Enter a valid email address' })),
          password: z.string().min(8, t('validation.passwordMin', { defaultValue: 'Password must be at least 8 characters' })),
          confirmPassword: z.string().min(8, t('validation.confirmPassword', { defaultValue: 'Confirm your password' })),
        })
        .refine(data => data.password === data.confirmPassword, {
          message: t('validation.passwordsDoNotMatch', { defaultValue: 'Passwords do not match' }),
          path: ['confirmPassword'],
        }),
    [t],
  );
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
        label: t('register.strength.enterPassword', { defaultValue: 'Enter a password' }),
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
    const defaultTier = { label: t('register.strength.weak', { defaultValue: 'Weak' }), className: 'bg-destructive', minScore: 0 };

    return {
      label: tier?.label ? t(/* i18n-dynamic */ `register.strength.${tier.label.toLowerCase().replace(' ', '')}`, { defaultValue: tier.label }) : defaultTier.label,
      className: tier?.className ?? defaultTier.className,
      percent
    };
  }, [passwordValue, t]);

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="space-y-2">
        <label htmlFor="name" className="text-sm font-medium">
          {t('fields.name', { defaultValue: 'Name' })}
        </label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          placeholder={t('placeholders.fullName', { defaultValue: 'Jane Doe' })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('name')}
        />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          {t('fields.email', { defaultValue: 'Email' })}
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder={t('placeholders.email', { defaultValue: 'you@company.com' })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('email')}
        />
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          {t('fields.password', { defaultValue: 'Password' })}
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder={t('placeholders.createPassword', { defaultValue: 'Create a password' })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-sm text-destructive">{errors.password.message}</p>
        )}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('register.strength.label', { defaultValue: 'Password strength' })}</span>
            <span>{strength.label}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full transition-all', strength.className, widthPercentClass(strength.percent))}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          {t('fields.confirmPassword', { defaultValue: 'Confirm password' })}
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder={t('placeholders.confirmPassword', { defaultValue: 'Re-enter your password' })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
        {isLoading ? t('register.creating', { defaultValue: 'Creating account...' }) : submitLabel ?? t('register.submit', { defaultValue: 'Create account' })}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        {t('common.alreadyHaveAccount', { defaultValue: 'Already have an account?' })}{' '}
        <a href="/login" className="font-medium text-primary hover:underline">
          {t('common.signIn', { defaultValue: 'Sign in' })}
        </a>
      </p>
    </form>
  );
}
