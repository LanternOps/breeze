/**
 * SSR-safe URL-hash-derived state (#2421).
 *
 * The URL fragment is never sent to the server, so any state derived from
 * `window.location.hash` inside a `useState` initializer renders differently
 * on the server and on the first client render — React discards the SSR tree
 * with a hydration-mismatch error on every deep link to a non-default tab
 * (the #2383 regression class, first fixed for IntegrationsPage in #2416).
 *
 * These hooks encode the #2416 fix pattern:
 *   1. State starts from the SSR-safe default, so the first client render
 *      matches the server-rendered HTML.
 *   2. The hash is adopted in a layout effect — post-commit but pre-paint, so
 *      deep links land on the right tab without a visible flash of the
 *      default.
 *   3. The same handler subscribes to `hashchange` for back/forward and
 *      externally-changed hashes.
 *
 * Writing the hash on tab change stays with the caller (CLAUDE.md mandates
 * `window.location.hash = id` for tab state) — only the READ moves post-mount.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

// useLayoutEffect warns during SSR (it is a no-op there); useEffect is the
// server-safe stand-in. On the client we want the layout variant so the hash
// is adopted before paint.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

// One window `hashchange` listener shared by every useHashState on the page
// (#8978). With a listener per hook, a page holding several hooks was
// committed after each listener (hashchange is a discrete event), so an
// external hash change (sidebar link, bookmark, back/forward) landed one field
// at a time and a state-to-hash writer could clobber the half-applied URL.
// A single listener runs all appliers in one event callback, so React batches
// them into one commit.
const hashAppliers = new Set<() => void>();
let hashListenerAttached = false;

function onHashChange(): void {
  for (const apply of Array.from(hashAppliers)) {
    // One hook's throwing parser must not starve the rest (they used to have
    // independent listeners); surface the error without aborting the loop.
    try {
      apply();
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}

function subscribeHashChange(apply: () => void): () => void {
  hashAppliers.add(apply);
  if (!hashListenerAttached) {
    window.addEventListener("hashchange", onHashChange);
    hashListenerAttached = true;
  }
  return () => {
    hashAppliers.delete(apply);
    if (hashAppliers.size === 0 && hashListenerAttached) {
      window.removeEventListener("hashchange", onHashChange);
      hashListenerAttached = false;
    }
  };
}

/**
 * Hash-derived state with a custom parser.
 *
 * @param defaultValue SSR-safe default — what the server rendered.
 * @param parse Maps the raw hash (leading `#` stripped) to a value, or
 *   `undefined` when the hash doesn't apply (empty/unrecognized), in which
 *   case the state falls back to `defaultValue`.
 * @returns `[value, setValue]` — `setValue` is a plain state setter; callers
 *   keep writing `window.location.hash` themselves on user-driven changes.
 */
export function useHashState<T>(
  defaultValue: T,
  parse: (hash: string) => T | undefined,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(defaultValue);

  // Latest-ref so the mount-once effect always sees the current parser and
  // default without re-subscribing to hashchange on every render (both are
  // typically inline/derived-from-props at call sites).
  const latest = useRef({ defaultValue, parse });
  latest.current = { defaultValue, parse };

  useIsomorphicLayoutEffect(() => {
    const applyHash = () => {
      const raw = window.location.hash.replace(/^#/, "");
      const parsed = latest.current.parse(raw);
      setValue(parsed === undefined ? latest.current.defaultValue : parsed);
    };
    applyHash();
    return subscribeHashChange(applyHash);
  }, []);

  return [value, setValue];
}

/**
 * Hash-selected tab: the common case where the hash must be one of a fixed
 * set of tab ids, anything else falling back to the default tab.
 */
export function useHashTab<T extends string>(
  validTabs: readonly T[],
  defaultTab: T,
): [T, Dispatch<SetStateAction<T>>] {
  return useHashState<T>(defaultTab, (hash) =>
    (validTabs as readonly string[]).includes(hash) ? (hash as T) : undefined,
  );
}
