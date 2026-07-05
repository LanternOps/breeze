/**
 * Status text for a finding row in the drawers. Accepted findings say *until
 * when* the risk acceptance runs ("Accepted until 8/1/2026") instead of a bare
 * "accepted" chip — one shared component so both drawers phrase it the same.
 */
export function FindingStatus({ status, acceptedUntil }: { status: string; acceptedUntil: string | null }) {
  if (status === 'accepted' && acceptedUntil) {
    return (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        Accepted until {new Date(acceptedUntil).toLocaleDateString()}
      </span>
    );
  }
  return <span className="text-xs capitalize text-muted-foreground">{status}</span>;
}

export default FindingStatus;
