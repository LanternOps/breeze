/**
 * The closing line of the Hardware Lifecycle report: how to reach the MSP
 * about the plan. Renders nothing without a contact email, since a report
 * that tells a customer to "contact us" with no address is worse than silent.
 */
export function LifecycleClosing({
  contactEmail,
  contactName,
}: {
  contactEmail?: string | null;
  contactName?: string | null;
}) {
  if (!contactEmail) return null;

  const who = contactName ? `${contactName} (${contactEmail})` : contactEmail;

  return (
    <p data-testid="lifecycle-closing" className="text-sm text-muted-foreground">
      To approve or discuss this plan, contact {who}. We will send quotes for the "Now" group first.
    </p>
  );
}
