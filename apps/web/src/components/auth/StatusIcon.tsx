type Variant = 'success' | 'error' | 'pending';

interface StatusIconProps {
  variant: Variant;
  /**
   * Optional accessible label for the icon. The icon is decorative by
   * default (`aria-hidden`), so most callers can omit this.
   */
  label?: string;
}

const VARIANT_STYLES: Record<Variant, { ring: string; text: string }> = {
  success: { ring: 'bg-success/10', text: 'text-success' },
  error: { ring: 'bg-destructive/10', text: 'text-destructive' },
  pending: { ring: 'bg-primary/10', text: 'text-primary' },
};

const PATHS: Record<Variant, JSX.Element> = {
  success: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
  ),
  error: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
  ),
  pending: (
    <>
      <circle cx="12" cy="12" r="9" strokeWidth="2" strokeOpacity="0.25" />
      <path strokeLinecap="round" strokeWidth="2" d="M12 3a9 9 0 0 1 9 9" className="origin-center animate-spin" style={{ animationDuration: '900ms' }} />
    </>
  ),
};

export default function StatusIcon({ variant, label }: StatusIconProps) {
  const { ring, text } = VARIANT_STYLES[variant];
  return (
    <div
      className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${ring}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg className={`h-6 w-6 ${text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {PATHS[variant]}
      </svg>
    </div>
  );
}
