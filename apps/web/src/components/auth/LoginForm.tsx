import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRegistrationGate } from '../../stores/featuresStore';

type LoginFormValues = {
  email: string;
  password: string;
};

// Org-axis SSO discovered from the address the user typed (#3229). When set,
// the form collapses its PASSWORD controls only and keeps the email field
// visible — unlike the partner-axis collapse in LoginPage, which happens at
// page load and can drop the whole form because nothing has been typed yet.
// Collapsing the email field here would delete the very input the discovery
// keys on, and the user could no longer correct a typo'd address.
type LoginFormSsoPrompt = {
  providerName: string;
  onSelect: () => void;
  onUsePassword: () => void;
  busy?: boolean;
};

type LoginFormProps = {
  onSubmit?: (values: LoginFormValues) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
  /** Fired with the raw field value when the email input loses focus. */
  onEmailSettled?: (email: string) => void;
  ssoPrompt?: LoginFormSsoPrompt | null;
};

export default function LoginForm({
  onSubmit,
  errorMessage,
  submitLabel,
  loading,
  onEmailSettled,
  ssoPrompt
}: LoginFormProps) {
  const { t } = useTranslation('auth');
  const loginSchema = useMemo(
    () =>
      z.object({
        email: z.string().email(t('validation.email', { defaultValue: 'Enter a valid email address' })),
        password: z.string().min(8, t('validation.passwordMin', { defaultValue: 'Password must be at least 8 characters' })),
      }),
    [t],
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  // Gate the registration link on the runtime /config flag, not a build-time
  // constant — prebuilt images can't honor PUBLIC_ENABLE_REGISTRATION (#1308).
  // Hidden until /config confirms it's enabled, so we never flash a link that
  // the server would reject.
  const { enabled: registrationEnabled } = useRegistrationGate();

  // Collapsed: the password controls are replaced by the SSO button. Enter in
  // the email field and a click on the button must do the same thing, so the
  // button IS the submit control and the form's submit handler is swapped —
  // otherwise implicit submission would run the password validator against a
  // field that isn't rendered and surface a "password must be 8 characters"
  // error for a flow that has no password.
  const emailField = register('email');

  return (
    <form
      onSubmit={
        ssoPrompt
          ? (event) => {
              event.preventDefault();
              ssoPrompt.onSelect();
            }
          : handleSubmit(async values => {
              await onSubmit?.(values);
            })
      }
      className="space-y-6"
    >
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          {t('fields.email', { defaultValue: 'Email' })}
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder={t('placeholders.email', { defaultValue: 'you@company.com' })}
          data-testid="login-email-input"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...emailField}
          onBlur={(event) => {
            // Compose, never replace: react-hook-form's own onBlur is what marks
            // the field touched and runs its validation.
            void emailField.onBlur(event);
            onEmailSettled?.(event.target.value);
          }}
        />
        {errors.email && (
          <p data-testid="login-email-error" className="text-sm text-destructive">{errors.email.message}</p>
        )}
      </div>

      {!ssoPrompt && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium">
              {t('fields.password', { defaultValue: 'Password' })}
            </label>
            <a href="/forgot-password" className="text-sm text-primary hover:underline">
              {t('login.forgotPassword', { defaultValue: 'Forgot password?' })}
            </a>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder={t('placeholders.currentPassword', { defaultValue: 'Enter your password' })}
            data-testid="login-password-input"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('password')}
          />
          {errors.password && (
            <p data-testid="login-password-error" className="text-sm text-destructive">{errors.password.message}</p>
          )}
        </div>
      )}

      {errorMessage && (
        <div
          data-testid="login-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      )}

      {ssoPrompt ? (
        <div className="space-y-3">
          <button
            type="submit"
            disabled={ssoPrompt.busy}
            data-testid="org-sso-button"
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('login.signInWithProvider', {
              defaultValue: `Sign in with ${ssoPrompt.providerName}`,
              providerName: ssoPrompt.providerName,
            })}
          </button>
          {/*
            The reveal is NOT a bypass: the server refuses the password anyway
            (ssoPolicy). It exists so a user whose IdP is down, or who reached a
            shared login page from a different tenant, is never trapped in a
            dead end with no way back to the form — the #4067 lockout lesson.
          */}
          <button
            type="button"
            data-testid="org-sso-use-password"
            onClick={ssoPrompt.onUsePassword}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {t('login.signInWithPasswordInstead', { defaultValue: 'Sign in with password instead' })}
          </button>
        </div>
      ) : (
        <button
          type="submit"
          disabled={isLoading}
          data-testid="login-submit"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? t('login.signingIn', { defaultValue: 'Signing in...' }) : submitLabel ?? t('common.signIn', { defaultValue: 'Sign in' })}
        </button>
      )}

      {registrationEnabled && (
        <div className="space-y-2 text-center text-sm text-muted-foreground">
          <p>
            {t('login.newHere', { defaultValue: 'New here?' })}{' '}
            <a href="/register-partner" className="font-medium text-primary hover:underline">
              {t('login.registerMsp', { defaultValue: 'Register your MSP' })}
            </a>
          </p>
        </div>
      )}
    </form>
  );
}
