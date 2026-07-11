import { i18n } from '@/lib/i18n';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { cn, widthPercentClass } from '@/lib/utils';

const createChangePasswordSchema = (t: TFunction) => z
  .object({
    currentPassword: z.string().min(1, t('changePasswordForm.currentPasswordIsRequired')),
    newPassword: z.string().min(8, t('changePasswordForm.passwordMustBeAtLeast8Characters')),
    confirmPassword: z.string().min(8, t('changePasswordForm.confirmYourNewPassword'))
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: t('changePasswordForm.passwordsDoNotMatch'),
    path: ['confirmPassword']
  })
  .refine(data => data.currentPassword !== data.newPassword, {
    message: t('changePasswordForm.newPasswordMustBeDifferentFromCurrentPassword'),
    path: ['newPassword']
  });

type ChangePasswordFormValues = z.infer<ReturnType<typeof createChangePasswordSchema>>;

type ChangePasswordFormProps = {
  onSubmit?: (values: ChangePasswordFormValues) => void | Promise<void>;
  errorMessage?: string;
  successMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

type StrengthConfig = {
  labelKey: string;
  className: string;
  minScore: number;
};

const strengthScale: StrengthConfig[] = [
  { labelKey: 'changePasswordForm.tooWeak', className: 'bg-destructive', minScore: 0 },
  { labelKey: 'changePasswordForm.weak', className: 'bg-destructive/70', minScore: 2 },
  { labelKey: 'changePasswordForm.fair', className: 'bg-amber-500', minScore: 3 },
  { labelKey: 'changePasswordForm.good', className: 'bg-emerald-500', minScore: 4 },
  { labelKey: 'changePasswordForm.strong', className: 'bg-emerald-600', minScore: 5 }
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
  submitLabel,
  loading
}: ChangePasswordFormProps) {
  const { t } = useTranslation('settings');
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(createChangePasswordSchema(t)),
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
        label: t('changePasswordForm.enterAPassword'),
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
    const defaultTier = { label: t('changePasswordForm.weak'), className: 'bg-destructive', minScore: 0 };

    return {
      label: tier ? t(/* i18n-dynamic */ tier.labelKey) : defaultTier.label,
      className: tier?.className ?? defaultTier.className,
      percent
    };
  }, [newPasswordValue, t]);

  const handleFormSubmit = async (values: ChangePasswordFormValues) => {
    await onSubmit?.(values);
    reset();
  };

  return (
    <form
      onSubmit={handleSubmit(handleFormSubmit)}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('changePasswordForm.changePassword')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('changePasswordForm.updateYourPasswordToKeepYourAccountSecure')}</p>
      </div>

      <div className="space-y-2">
        <label htmlFor="currentPassword" className="text-sm font-medium">
          {t('changePasswordForm.currentPassword')}</label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          placeholder={t('changePasswordForm.enterYourCurrentPassword')}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('currentPassword')}
        />
        {errors.currentPassword && (
          <p className="text-sm text-destructive">{errors.currentPassword.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="newPassword" className="text-sm font-medium">
          {t('changePasswordForm.newPassword')}</label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          placeholder={t('changePasswordForm.createANewPassword')}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('newPassword')}
        />
        {errors.newPassword && (
          <p className="text-sm text-destructive">{errors.newPassword.message}</p>
        )}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('changePasswordForm.passwordStrength')}</span>
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
          {t('changePasswordForm.confirmNewPassword')}</label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder={t('changePasswordForm.reEnterYourNewPassword')}
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
        {isLoading ? t('changePasswordForm.changingPassword') : (submitLabel ?? t('changePasswordForm.changePassword'))}
      </button>
    </form>
  );
}
