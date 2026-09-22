/**
 * W05 seam (caller verification #6354): cancel every queued action intent
 * that targets one of the subject's bindings after a "This is not me"
 * rejection. W01 ships the mandated no-op — the ONLY intentional stub in the
 * caller-verification backend — so the rejection handler's call order and
 * incident summary are fixed now and W05 only has to replace this body.
 *
 * Returns the three id lists the incident summary reports: intents this call
 * cancelled, intents already executing (cannot be stopped), and intents
 * already dispatched to the backend before the rejection (confirm in Entra
 * whether the change landed).
 */
export async function revokeIntentsForSubject(input: {
  orgId: string;
  bindingIds: string[];
  verificationId: string;
}): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }> {
  void input;
  return { cancelled: [], alreadyExecuting: [], alreadyDispatched: [] };
}
