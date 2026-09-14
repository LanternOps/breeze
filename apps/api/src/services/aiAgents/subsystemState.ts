/**
 * The AI-agent subsystem's platform kill switch, and how a process announces
 * it at boot (#5380 / #5381).
 *
 * Deliberately its OWN module, separate from `skipVisibility.ts`, and
 * deliberately importing nothing but `config/env`: `index.ts` and `worker.ts`
 * call `logAiAgentsSubsystemState` from inside their boot path, and every
 * transitive import a boot module gains is one the boot tests have to mock.
 * Pointing them at `skipVisibility.ts` pulled `services/redis` into
 * `worker.ts`'s module graph and hung 14 cases in `worker.boot.test.ts`.
 */
import { envFlag } from '../../config/env';

/** The env var a self-hoster has to set. Surfaced to the web app so the
 *  disabled banner can name it instead of saying "ask your operator". */
export const AI_AGENTS_ENV_FLAG_NAME = 'BREEZE_AI_AGENTS_ENABLED';

/**
 * Call-time read of the platform kill switch — deliberately NOT the
 * module-load-time `AI_AGENTS_ENABLED` const from `config/env`. This is the
 * same shape `runService.ts`'s admission check uses (`envFlag(...)` on every
 * call), so what the settings page reports can never disagree with what
 * admission actually did.
 */
export function aiAgentsEnvFlagEnabled(): boolean {
  return envFlag(AI_AGENTS_ENV_FLAG_NAME, false);
}

/**
 * One unambiguous line per process at boot. The runner and the sweep
 * scheduler log "initialized" whether or not the flag is set, which reads as
 * "the subsystem is up" when it is in fact inert (#5381).
 *
 * Takes `enabled` rather than calling `aiAgentsEnvFlagEnabled()` itself: both
 * boot sites already hold `AI_AGENTS_ENABLED` (they pass it to
 * `declareExpectedConsumers` on the line above), and reading `process.env`
 * again here would add an `envFlag` dependency to a module graph whose boot
 * tests mock `config/env` down to the three symbols they use — which is
 * exactly how this hung `worker.boot.test.ts`. Boot-time is also the RIGHT
 * moment for the module-load-time const: it is reporting what this process
 * started with.
 */
export function logAiAgentsSubsystemState(processLabel: string, enabled: boolean): void {
  if (enabled) {
    console.info(
      `[AiAgents] ENABLED — ${AI_AGENTS_ENV_FLAG_NAME} is set; agent triggers will create runs (process: ${processLabel})`,
    );
    return;
  }
  console.warn(
    `[AiAgents] DISABLED — ${AI_AGENTS_ENV_FLAG_NAME} is not set; every agent trigger will be skipped (process: ${processLabel})`,
  );
}
