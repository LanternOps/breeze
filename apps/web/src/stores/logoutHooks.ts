// Logout hooks (#9427 W3, T14). auth.ts's evictLocalAuthState runs these,
// synchronously, before it wipes local storage, so stores that hold runtime
// tenant data (the AI workspace tabs, live attach readers) are cleared first
// and their persist middleware has nothing left to write back.
//
// Kept out of auth.ts on purpose: the stores import this module, not ./auth,
// to register, so auth.ts never imports a store (both stores import ./auth;
// a cycle would break evictLocalAuthState's synchronous contract), and the
// many tests that mock ./auth with only fetchWithAuth keep working. auth.ts
// re-exports registerLogoutHook as its public name.
//
// The registry lives on globalThis, like the toast bus (components/shared/
// Toast.tsx): under Astro/Vite dev each island can hold its own copy of a
// module, and logout must reach the hooks every copy registered.

type LogoutHook = () => void;
type Holder = typeof globalThis & { __breezeLogoutHooks_v1?: Set<LogoutHook> };

function hooks(): Set<LogoutHook> {
  const holder = globalThis as Holder;
  return (holder.__breezeLogoutHooks_v1 ??= new Set<LogoutHook>());
}

/** Register `fn` to run at logout, before local storage is cleared. Returns an unregister function. */
export function registerLogoutHook(fn: LogoutHook): () => void {
  hooks().add(fn);
  return () => { hooks().delete(fn); };
}

/** Run every hook; one that throws is logged and does not stop the others or the logout. */
export function runLogoutHooks(): void {
  for (const fn of [...hooks()]) {
    try {
      fn();
    } catch (err) {
      console.error('[auth] A logout hook failed:', err);
    }
  }
}
