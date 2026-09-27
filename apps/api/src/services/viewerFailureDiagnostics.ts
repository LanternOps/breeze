/**
 * The terminal desktop rows the viewer may still read (never connect to) under
 * the read-only `failure-diagnostics` access mode, after its token has been
 * revoked: a failed start (#4162), a disconnect with a recorded stop reason
 * (#5300), and a consent refusal with its recorded reason (#6818). Each is
 * readable for its reason only; a terminal row with no reason stays closed.
 */
export function isViewerFailureDiagnosticRow(status: string, errorMessage: string | null | undefined): boolean {
  if (status === 'failed') return true;
  return (status === 'disconnected' || status === 'denied') && !!errorMessage;
}
