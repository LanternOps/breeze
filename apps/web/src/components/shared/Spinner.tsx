/** Inline button spinner; static (no spin) under prefers-reduced-motion. */
export default function Spinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none ${className}`}
      aria-hidden="true"
    />
  );
}
