import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const portalLoginSchema = z.object({
  organization: z.string().min(2, 'Enter your organization name or code'),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters')
});

type PortalLoginValues = z.infer<typeof portalLoginSchema>;

type PortalLoginFormProps = {
  onSubmit?: (values: PortalLoginValues) => void | Promise<void>;
  onLookupOrg?: (organization: string) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

export default function PortalLoginForm({
  onSubmit,
  onLookupOrg,
  errorMessage,
  submitLabel = 'Sign in',
  loading
}: PortalLoginFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<PortalLoginValues>({
    resolver: zodResolver(portalLoginSchema),
    defaultValues: {
      organization: '',
      email: '',
      password: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const orgValue = watch('organization');

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="space-y-2">
        <label htmlFor="organization" className="text-sm font-medium">
          Organization
        </label>
        <div className="flex items-center gap-2">
          <input
            id="organization"
            type="text"
            autoComplete="organization"
            placeholder="Acme Corp or ORG-123"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('organization')}
          />
          <button
            type="button"
            onClick={() => onLookupOrg?.(orgValue)}
            className="h-10 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted"
          >
            Lookup
          </button>
        </div>
        {errors.organization && (
          <p className="text-sm text-destructive">{errors.organization.message}</p>
        )}
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
          autoComplete="current-password"
          placeholder="Enter your password"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-sm text-destructive">{errors.password.message}</p>
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
        {isLoading ? 'Signing in...' : submitLabel}
      </button>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <a href="/portal/forgot-password" className="hover:text-foreground hover:underline">
          Forgot password?
        </a>
        <a href="/portal/support" className="hover:text-foreground hover:underline">
          Need help?
        </a>
      </div>
    </form>
  );
}
