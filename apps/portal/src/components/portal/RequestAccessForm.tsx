import { withBase } from '@/lib/basePath';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import { requestPortalAccess, type RequestAccessResult } from '@/lib/selfRegistration';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, INPUT } from './ui';

// Mirrors the API's selfRegisterSchema (routes/portal/schemas.ts) so a bad
// value fails here, before any request. The server stays authoritative.
/** Control, format and line/paragraph-separator characters (the API refuses them too). */
const DISALLOWED_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const requestAccessSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Please enter your name')
    .max(120, 'Use 120 characters or fewer')
    .refine((value) => !DISALLOWED_NAME_CHARS.test(value), 'Remove the special characters from your name'),
  email: z.string().trim().email('Please enter a valid email address').max(254, 'Please enter a valid email address')
});

type RequestAccessFormData = z.infer<typeof requestAccessSchema>;

/** One message per failure class. None of them depends on the address (the API's answers don't either). */
const ERROR_COPY: Record<Exclude<RequestAccessResult['status'], 'sent'>, string> = {
  throttled: 'Too many requests. Please try again later.',
  invalid: 'Check your name and email and try again.',
  not_available: "Requesting access isn't available here. Contact your IT provider.",
  failed: "We couldn't send your request. Try again in a few minutes."
};

export function RequestAccessForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<RequestAccessFormData>({
    resolver: zodResolver(requestAccessSchema)
  });

  const onSubmit = async (data: RequestAccessFormData) => {
    setIsLoading(true);
    setError(null);
    const result = await requestPortalAccess({ name: data.name, email: data.email });
    if (result.status === 'sent') {
      setSentMessage(result.message);
    } else {
      setError(ERROR_COPY[result.status]);
    }
    setIsLoading(false);
  };

  if (sentMessage) {
    // The same confirmation for every address: the page never says whether an
    // address is eligible, has an account, or is on a known domain.
    return (
      <div role="status" data-testid="request-access-sent" className="border-y border-border/70 py-12 text-center">
        <h3 className="font-display text-lg font-semibold text-foreground">Check your email</h3>
        <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted-foreground">{sentMessage}</p>
        <p className="mx-auto mt-2 max-w-[38ch] text-sm text-muted-foreground">
          The link in the email works once and expires in 30 minutes.
        </p>
        <a
          href={withBase('/login')}
          className="mt-4 inline-flex items-center justify-center gap-2 text-sm font-medium text-primary-on-tint underline-offset-4 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    // Pre-hydration safety net, same rationale as AcceptInviteForm (#2868): a
    // native submit must never be a GET carrying the address in the URL.
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      data-testid="request-access-form"
      className="space-y-6 rounded-lg border border-border/70 bg-card p-6 sm:p-8"
    >
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Enter your name and your work email. If your organization lets you request access, we'll email you a link
          to confirm.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div>
        <label htmlFor="request-access-name" className="block text-sm font-medium text-foreground">
          Full name
        </label>
        <input
          id="request-access-name"
          data-testid="request-access-name"
          type="text"
          autoComplete="name"
          maxLength={120}
          {...register('name')}
          className={cn(INPUT, errors.name && 'border-destructive')}
        />
        {errors.name && <p className="mt-1 text-sm text-destructive-on-tint">{errors.name.message}</p>}
      </div>

      <div>
        <label htmlFor="request-access-email" className="block text-sm font-medium text-foreground">
          Work email
        </label>
        <input
          id="request-access-email"
          data-testid="request-access-email"
          type="email"
          autoComplete="email"
          maxLength={254}
          {...register('email')}
          className={cn(INPUT, errors.email && 'border-destructive')}
        />
        {errors.email && <p className="mt-1 text-sm text-destructive-on-tint">{errors.email.message}</p>}
      </div>

      <button type="submit" data-testid="request-access-submit" disabled={isLoading} className={cn(BTN_PRIMARY, 'w-full')}>
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Sending
          </>
        ) : (
          'Request access'
        )}
      </button>

      <a
        href={withBase('/login')}
        className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to sign in
      </a>
    </form>
  );
}

export default RequestAccessForm;
