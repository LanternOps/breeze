// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { useHashState, useHashTab } from "./useHashState";

const TABS = ["inventory", "policies"] as const;
type Tab = (typeof TABS)[number];

/**
 * Probe that records the value of every render pass, so the tests can assert
 * what the FIRST render produced (the hydration-relevant render) separately
 * from the post-effect value. `render()` commits effects synchronously, so
 * `screen` alone would only ever show the post-effect value.
 */
function makeProbe() {
  const renders: string[] = [];
  let setTab: (t: Tab) => void = () => {};
  function Probe({ defaultTab = "inventory" as Tab }: { defaultTab?: Tab }) {
    const [tab, set] = useHashTab<Tab>(TABS, defaultTab);
    setTab = set;
    renders.push(tab);
    return createElement("div", { "data-testid": "tab" }, tab);
  }
  return { Probe, renders, selectTab: (t: Tab) => setTab(t) };
}

function setHash(hash: string) {
  window.location.hash = hash;
}

function fireHashChange(hash: string) {
  act(() => {
    setHash(hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("useHashTab", () => {
  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
  });

  it("first render uses the SSR-safe default even when a valid hash is present", () => {
    setHash("#policies");
    const { Probe, renders } = makeProbe();
    render(createElement(Probe));
    // Render #1 must match what the server rendered (the default) — reading
    // the hash there is exactly the hydration-mismatch bug (#2421).
    expect(renders[0]).toBe("inventory");
    // The layout effect then adopts the hash before paint.
    expect(screen.getByTestId("tab").textContent).toBe("policies");
  });

  it("stays on the default when the hash is empty", () => {
    const { Probe, renders } = makeProbe();
    render(createElement(Probe));
    expect(renders[0]).toBe("inventory");
    expect(screen.getByTestId("tab").textContent).toBe("inventory");
  });

  it("falls back to the default when the hash is not a valid tab", () => {
    setHash("#not-a-tab");
    const { Probe } = makeProbe();
    render(createElement(Probe));
    expect(screen.getByTestId("tab").textContent).toBe("inventory");
  });

  it("respects a non-standard default tab", () => {
    const { Probe } = makeProbe();
    render(createElement(Probe, { defaultTab: "policies" as Tab }));
    expect(screen.getByTestId("tab").textContent).toBe("policies");
  });

  it("follows hashchange events (back/forward, external changes)", () => {
    const { Probe } = makeProbe();
    render(createElement(Probe));
    expect(screen.getByTestId("tab").textContent).toBe("inventory");

    fireHashChange("#policies");
    expect(screen.getByTestId("tab").textContent).toBe("policies");

    // Navigating back to an empty/unknown hash returns to the default.
    fireHashChange("#");
    expect(screen.getByTestId("tab").textContent).toBe("inventory");
  });

  it("returns a working setter for direct tab selection", () => {
    const { Probe, selectTab } = makeProbe();
    render(createElement(Probe));
    act(() => selectTab("policies"));
    expect(screen.getByTestId("tab").textContent).toBe("policies");
  });

  it("removes the hashchange listener on unmount", () => {
    const { Probe } = makeProbe();
    const { unmount } = render(createElement(Probe));
    unmount();
    // Must not throw (setState on unmounted component would warn/leak).
    expect(() => fireHashChange("#policies")).not.toThrow();
  });
});

describe("useHashState", () => {
  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
  });

  it("uses the custom parser and falls back to the default on undefined", () => {
    setHash("#page-3");
    const renders: number[] = [];
    function Probe() {
      const [page] = useHashState<number>(1, (hash) => {
        const m = /^page-(\d+)$/.exec(hash);
        return m ? Number(m[1]) : undefined;
      });
      renders.push(page);
      return createElement("div", { "data-testid": "page" }, String(page));
    }
    render(createElement(Probe));
    expect(renders[0]).toBe(1); // SSR-safe first render
    expect(screen.getByTestId("page").textContent).toBe("3");

    fireHashChange("#garbage");
    expect(screen.getByTestId("page").textContent).toBe("1");
  });
});
