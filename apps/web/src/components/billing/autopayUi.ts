/**
 * Button styles for the staff automatic-payment screens. The web app has no shared
 * Button component; domains keep one set of class constants (see pam/ui.tsx).
 */
export const autopayButton = {
  primary: 'inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50',
  secondary: 'inline-flex items-center justify-center rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50',
  danger: 'inline-flex items-center justify-center rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50',
} as const;
