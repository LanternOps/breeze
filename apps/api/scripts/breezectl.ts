#!/usr/bin/env tsx
/**
 * `breezectl` — the operational CLI shipped inside the stock Breeze API image.
 *
 * A thin argv/exit-code shell around breezectl.lib.ts (same split as
 * recover-stuck-agents.ts / .lib.ts, which keeps the logic unit-testable
 * without executing a `main()` on import).
 *
 * Usage inside the container:
 *   pnpm breezectl extensions list
 *   node dist/scripts/breezectl.cjs extensions disable demo
 *
 * Run `breezectl extensions` with no verb for the full flag reference.
 */
import { defaultOptions, runBreezectl } from './breezectl.lib';

runBreezectl(process.argv.slice(2), defaultOptions()).catch((error: unknown) => {
  // The library throws Errors with operator-facing messages; print the message
  // rather than a stack so the guidance is the first thing on screen.
  console.error(`[breezectl] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
