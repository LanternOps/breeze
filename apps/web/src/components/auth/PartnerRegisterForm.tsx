import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import PasswordInput from './PasswordInput';
import PasswordStrength from './PasswordStrength';

type PartnerRegisterFormValues = {
  companyName: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptTerms: boolean;
};

type PartnerRegisterFormProps = {
  onSubmit?: (values: PartnerRegisterFormValues) => void | Promise<void>;
  errorMessage?: string;
  loading?: boolean;
};

export default function PartnerRegisterForm({
  onSubmit,
  errorMessage,
  loading
}: PartnerRegisterFormProps) {
  const { t } = useTranslation('auth');
  const partnerRegisterSchema = useMemo(
    () =>
      z
        .object({
          companyName: z.string().min(2, t('validation.companyNameMin', { defaultValue: 'Company name must be at least 2 characters' })),
          name: z.string().min(2, t('validation.nameMin', { defaultValue: 'Name must be at least 2 characters' })),
          email: z.string().email(t('validation.email', { defaultValue: 'Enter a valid email address' })),
          password: z.string().min(8, t('validation.passwordMin', { defaultValue: 'Password must be at least 8 characters' })),
          confirmPassword: z.string().min(8, t('validation.confirmPassword', { defaultValue: 'Confirm your password' })),
          acceptTerms: z.boolean().refine(val => val === true, {
            message: t('validation.acceptTerms', { defaultValue: 'You must accept the terms of service' }),
          }),
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
    trigger,
    formState: { errors, isSubmitting, touchedFields }
  } = useForm<PartnerRegisterFormValues>({
    resolver: zodResolver(partnerRegisterSchema),
    mode: 'onBlur',
    defaultValues: {
      companyName: '',
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      acceptTerms: false
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const passwordValue = watch('password');

  const passwordErrId = useId();
  const confirmErrId = useId();

  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Company section */}
      <div>
        <h2 className="text-base font-semibold">{t('partnerRegister.company.title', { defaultValue: 'Your company' })}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t('partnerRegister.company.description', { defaultValue: 'This creates your MSP account in Breeze' })}
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="companyName" className="text-sm font-medium">
          {t('fields.companyName', { defaultValue: 'Company name' })}
        </label>
        <input
          id="companyName"
          type="text"
          placeholder={t('placeholders.companyName', { defaultValue: 'Acme IT Services' })}
          className={inputClass}
          data-testid="register-company-name"
          {...register('companyName')}
        />
        {errors.companyName && touchedFields.companyName && (
          <p className="text-sm text-destructive">{errors.companyName.message}</p>
        )}
      </div>

      {/* Account section */}
      <div className="border-t pt-6">
        <h2 className="text-base font-semibold">{t('partnerRegister.account.title', { defaultValue: 'Your account' })}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t('partnerRegister.account.description', { defaultValue: "You'll be the first admin for this company" })}
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="name" className="text-sm font-medium">
            {t('fields.fullName', { defaultValue: 'Full name' })}
          </label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            placeholder={t('placeholders.fullName', { defaultValue: 'Jane Doe' })}
            className={inputClass}
            data-testid="register-name"
            {...register('name')}
          />
          {errors.name && touchedFields.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            {t('fields.workEmail', { defaultValue: 'Work email' })}
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder={t('placeholders.email', { defaultValue: 'you@company.com' })}
            className={inputClass}
            data-testid="register-email"
            {...register('email')}
          />
          {errors.email && touchedFields.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            {t('fields.password', { defaultValue: 'Password' })}
          </label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            placeholder={t('placeholders.createPassword', { defaultValue: 'Create a password' })}
            data-testid="register-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? passwordErrId : undefined}
            {...register('password', {
              onChange: () => {
                if (touchedFields.confirmPassword) trigger('confirmPassword');
              }
            })}
          />
          {errors.password && touchedFields.password && (
            <p id={passwordErrId} className="text-sm text-destructive">{errors.password.message}</p>
          )}
          <PasswordStrength password={passwordValue ?? ''} />
        </div>

        <div className="space-y-2">
          <label htmlFor="confirmPassword" className="text-sm font-medium">
            {t('fields.confirmPassword', { defaultValue: 'Confirm password' })}
          </label>
          <PasswordInput
            id="confirmPassword"
            autoComplete="new-password"
            placeholder={t('placeholders.confirmPassword', { defaultValue: 'Re-enter your password' })}
            data-testid="register-confirm-password"
            aria-invalid={errors.confirmPassword ? true : undefined}
            aria-describedby={errors.confirmPassword ? confirmErrId : undefined}
            {...register('confirmPassword')}
          />
          {errors.confirmPassword && touchedFields.confirmPassword && (
            <p id={confirmErrId} className="text-sm text-destructive">{errors.confirmPassword.message}</p>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3">
        <input
          id="acceptTerms"
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
          data-testid="register-accept-terms"
          {...register('acceptTerms')}
        />
        <label htmlFor="acceptTerms" className="text-sm leading-snug text-muted-foreground">
          {t('partnerRegister.terms.prefix', { defaultValue: 'I agree to the' })}{' '}
          <a
            href="https://breezermm.com/legal/terms-of-service"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {t('partnerRegister.terms.termsOfService', { defaultValue: 'Terms of Service' })}
          </a>{' '}
          {t('partnerRegister.terms.and', { defaultValue: 'and' })}{' '}
          <a
            href="https://breezermm.com/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {t('partnerRegister.terms.privacyPolicy', { defaultValue: 'Privacy Policy' })}
          </a>
        </label>
      </div>
      {errors.acceptTerms && (
        <p className="text-sm text-destructive">{errors.acceptTerms.message}</p>
      )}

      {errorMessage && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading}
        data-testid="register-submit"
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading
          ? t('partnerRegister.creating', { defaultValue: 'Creating account...' })
          : t('partnerRegister.createCompanyAccount', { defaultValue: 'Create company account' })}
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
