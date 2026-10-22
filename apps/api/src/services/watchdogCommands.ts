/**
 * Watchdog recovery command types an operator may request directly (#9234).
 *
 * Deliberately dependency-free: routes read this at module scope (the request
 * schema), and many route test suites replace `./commandQueue` with a partial
 * mock. Keeping the constant out of commandQueue means those mocks never need
 * to know about it.
 */
export const WATCHDOG_RECOVERY_COMMAND_TYPES = ['restart_agent', 'start_agent'] as const;
export type WatchdogRecoveryCommandType = (typeof WATCHDOG_RECOVERY_COMMAND_TYPES)[number];
