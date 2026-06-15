import { beforeEach } from 'vitest';

beforeEach(() => {
  sessionStorage.clear();
  // Test-hygiene guard: the core API helpers fall back to the real global
  // `fetch` when no `fetchImpl` is injected. A unit test must NEVER hit the
  // network — a dropped `fetchImpl` once leaked requests to a live dev API
  // (surfaced by the client-AI error Monitor). Make that mistake fail LOUD
  // instead of silently calling out. Tests that exercise transport inject an
  // explicit `fetchImpl`, so this never affects legitimate tests.
  globalThis.fetch = (() => {
    throw new Error(
      'Unmocked global fetch in a unit test — pass an explicit fetchImpl; core API helpers must not hit the network.',
    );
  }) as typeof fetch;
});
