/**
 * Shared boot sequence for every host app's entry point (apps/<host>-addin/src/main.tsx).
 *
 * The load-bearing invariant: runtime config (/config.json) MUST be loaded
 * before the first render, because App's mount effect kicks off a silent
 * sign-in that lazily reads getApiBaseUrl()/getEntraClientId(). If render ran
 * before the config load resolved, a deployed environment would silently use
 * the build-time fallback (localhost API origin + empty Entra client ID) and
 * the first sign-in would fail. Centralising this here keeps the four main.tsx
 * files trivial and makes the ordering testable in one place (boot.test.ts).
 */
import { loadRuntimeConfig } from './config';

export async function bootAddin(
  render: () => void,
  loader: typeof loadRuntimeConfig = loadRuntimeConfig,
): Promise<void> {
  await loader();
  render();
}
