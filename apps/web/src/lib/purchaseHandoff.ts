import { launchPurchaseHandoffQuery, parseLaunchPurchaseHandoff } from '@breeze/shared';
import { getSafeNext } from './authNext';

// Keep the setup gate in place while preserving only the allowlisted purchase
// preference. Legacy next destinations retain their existing setup behavior.
function selectedBillingDestination(raw: string | null | undefined): string | null {
  const safe = getSafeNext(raw, '');
  if (!safe) return null;
  const target = new URL(safe, 'https://handoff.invalid');
  if (target.pathname !== '/billing/plans') return null;
  const handoff = parseLaunchPurchaseHandoff(target.searchParams);
  return handoff.kind === 'selected' ? `/billing/plans?${launchPurchaseHandoffQuery(handoff.selection)}` : null;
}

export function postLoginDestination(requiresSetup: boolean | undefined, safeNext: string): string {
  if (!requiresSetup) return safeNext;
  const selected = selectedBillingDestination(safeNext);
  return selected ? `/setup?next=${encodeURIComponent(selected)}` : '/setup';
}

export function setupCompletionDestination(search: string): string {
  return selectedBillingDestination(new URLSearchParams(search).get('next')) ?? '/';
}
