import { ShieldX } from 'lucide-react';

interface AccessDeniedProps {
  /**
   * Optional, resource-specific message. Falls back to a generic
   * permission-denied sentence. Keep it user-facing — never leak the raw
   * resource:action grant string.
   */
  message?: string;
  /** data-testid for e2e/unit assertions. Defaults to `access-denied`. */
  testId?: string;
}

/**
 * Distinct "you lack permission" state, rendered when an API call returns 403.
 *
 * This is deliberately NOT the generic "Failed to load / Try again" UI — a 403
 * is not a transient failure, so offering a retry button is misleading (it will
 * 403 again). Server-side `requirePermission` is the real gate; this component
 * just gives a permission-scoped user (e.g. "Partner Billing" landing on /roles)
 * a clear explanation instead of a confusing error.
 */
export default function AccessDenied({
  message = "You don't have permission to view this.",
  testId = 'access-denied',
}: AccessDeniedProps) {
  return (
    <div
      className="rounded-lg border border-border bg-muted/30 p-8 text-center"
      data-testid={testId}
      role="alert"
    >
      <ShieldX className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-4 text-base font-semibold">Access denied</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
      <p className="mx-auto mt-3 max-w-sm text-xs text-muted-foreground">
        If you believe you should have access, contact your administrator.
      </p>
    </div>
  );
}
