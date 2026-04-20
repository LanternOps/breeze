export default function ActivationComplete() {
  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
          <svg className="h-6 w-6 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold">You're all set</h2>
        <p className="text-sm text-muted-foreground">
          Return to your agent chat — it will detect activation and continue from there.
        </p>
      </div>
    </div>
  );
}
