/**
 * W03 (#7601) integration helper. Admission of an AI agent run resolves the
 * agent's model through the registry first (Task 12): a partner with no AI
 * configuration is cut over onto the platform deployment default, which is
 * only usable when the deployment has a platform key. Suites that exercise
 * agent admission (and never dispatch a model call) register a placeholder
 * key for their duration, the way the other W03 suites do. Not a test file.
 */
import { afterAll, beforeAll } from 'vitest';

export const PLATFORM_KEY_PLACEHOLDER = 'sk-ant-w03-integration-placeholder';

export function usePlatformAiKeyPlaceholder(): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY_PLACEHOLDER;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });
}
