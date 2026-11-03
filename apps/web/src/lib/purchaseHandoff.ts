import { launchPurchaseSelectionSchema, parseSignupIntentParams, signupIntentHandoffQuery } from '@breeze/shared';
import { getSafeNext } from './authNext';

// Keep the setup gate in place while preserving only the allowlisted signup
// intent. A legacy launch tuple resumes as the default cloud intent. Anything
// else keeps its existing setup behavior.
function selectedBillingDestination(raw: string | null | undefined): string | null {
  const safe = getSafeNext(raw, '');
  if (!safe) return null;
  const target = new URL(safe, 'https://handoff.invalid');
  if (target.pathname !== '/billing/plans') return null;
  const params = target.searchParams;
  if (params.has('intent') || params.has('offer')) {
    return `/billing/plans?${signupIntentHandoffQuery(parseSignupIntentParams(params))}`;
  }
  if (params.has('catalog')) {
    const legacy = launchPurchaseSelectionSchema.safeParse({
      catalogVersion: params.get('catalog'),
      capacity: Number(params.get('capacity')),
      billingPeriod: params.get('billing'),
    });
    if (legacy.success) return `/billing/plans?${signupIntentHandoffQuery({ intent: 'cloud' })}`;
  }
  return null;
}

export function postLoginDestination(requiresSetup: boolean | undefined, safeNext: string): string {
  if (!requiresSetup) return safeNext;
  const selected = selectedBillingDestination(safeNext);
  return selected ? `/setup?next=${encodeURIComponent(selected)}` : '/setup';
}

export function setupCompletionDestination(search: string): string {
  return selectedBillingDestination(new URLSearchParams(search).get('next')) ?? '/';
}
