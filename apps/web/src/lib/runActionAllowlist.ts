// Files in the targeted set permitted to call fetchWithAuth with a mutating
// method WITHOUT runAction, with the reason. Keep this list short and justified.
export const RUN_ACTION_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'apps/web/src/services/deviceActions.ts', reason: 'typed Wake service (WakeCommandError) — the pattern runAction generalizes' },
  { file: 'apps/web/src/stores/auth.ts', reason: 'transport/auth store, not a UI action handler' },
];
