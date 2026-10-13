import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../stores/auth", async (original) => ({
  ...(await original<typeof import("../../stores/auth")>()),
  fetchWithAuth: h.fetch,
}));
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => ({ scope: "partner", orgId: null, partnerId: "partner-1" }),
  loginPathWithNext: () => "/login",
}));
vi.mock("../../lib/permissions", () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector?: (s: { currentOrgId: null }) => unknown) =>
    selector ? selector({ currentOrgId: null }) : { currentOrgId: null },
}));
vi.mock("./SecurityIntegration", () => ({ default: () => <div data-testid="stub-security" /> }));
vi.mock("./HuntressIntegration", () => ({ default: () => <div data-testid="stub-huntress" /> }));
vi.mock("./EdrProvidersIntegration", () => ({ default: () => <div data-testid="stub-edr" /> }));

import IntegrationsPage from "./IntegrationsPage";

afterEach(() => {
  window.location.hash = "";
});

describe("IntegrationsPage — EDR providers sub-tab", () => {
  it("opens Security -> EDR providers from the #edr hash", () => {
    h.fetch.mockResolvedValue(Response.json({ data: [] }));
    window.location.hash = "#edr";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-edr")).toBeTruthy();
    expect(screen.queryByTestId("stub-security")).toBeNull();
    expect(screen.queryByTestId("stub-huntress")).toBeNull();
  });

  it("offers an EDR providers sub-tab button that writes #edr", () => {
    h.fetch.mockResolvedValue(Response.json({ data: [] }));
    window.location.hash = "#security";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-security")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "EDR providers" }));
    expect(window.location.hash).toBe("#edr");
    expect(screen.getByTestId("stub-edr")).toBeTruthy();
  });
});
