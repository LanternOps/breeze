export async function runReauthenticationTeardown(
  clear: () => Promise<void>,
  dispatchTerminal: () => void,
  captureUnexpected: (error: unknown) => void,
): Promise<void> {
  try {
    await clear();
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== 'SecureWipeError') captureUnexpected(error);
  } finally {
    dispatchTerminal();
  }
}
