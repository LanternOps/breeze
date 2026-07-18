import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let scope: "system" | "partner" | "organization" | null = "partner";
const m365State = vi.hoisted(() => ({
  legacyEnabled: true,
  graphReadEnabled: true,
}));
const orgState = vi.hoisted(() => ({
  currentOrgId: "11111111-1111-4111-8111-111111111111" as string | null,
  jwtOrgId: null as string | null,
}));

// Mock authScope so we can drive the Distributors-tab scope gate.
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => ({ scope, orgId: orgState.jwtOrgId, partnerId: "partner-1" }),
  loginPathWithNext: () => "/login",
}));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (value: { currentOrgId: string | null }) => unknown) =>
    selector({ currentOrgId: orgState.currentOrgId }),
}));

// Stub the heavy child panels so the test stays focused on tab/sub-tab wiring.
vi.mock("../webhooks/WebhooksPage", () => ({
  default: () => <div data-testid="stub-webhooks" />,
}));
vi.mock("./CommunicationIntegrations", () => ({
  default: () => <div data-testid="stub-notifications" />,
}));
vi.mock("../psa/PsaConnectionsPage", () => ({
  default: () => <div data-testid="stub-psa" />,
}));
vi.mock("./SecurityIntegration", () => ({
  default: () => <div data-testid="stub-security" />,
}));
vi.mock("./HuntressIntegration", () => ({
  default: () => <div data-testid="stub-huntress" />,
}));
vi.mock("./MonitoringIntegration", () => ({
  default: () => <div data-testid="stub-monitoring" />,
}));
vi.mock("./GoogleWorkspaceIntegration", () => ({
  default: () => <div data-testid="stub-google" />,
}));
vi.mock("./M365Integration", () => ({
  default: () => (
    <div data-testid="stub-m365" data-enabled={String(m365State.legacyEnabled)} />
  ),
}));
vi.mock("./M365CustomerGraphReadCard", () => ({
  M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS: [
    "active",
    "degraded",
    "consent_expired",
    "consent_state_mismatch",
    "consent_cancelled",
    "admin_role_required",
    "tenant_mismatch",
    "tenant_already_bound",
    "credential_unavailable",
    "identity_token_invalid",
    "application_token_invalid",
    "grant_reconciliation_unavailable",
    "grant_missing",
    "grant_unexpected",
    "manifest_stale",
    "organization_probe_failed",
    "executor_unavailable",
  ],
  default: ({
    callbackResult,
    callbackRefreshKey,
  }: {
    callbackResult?: string | null;
    callbackRefreshKey?: number;
  }) => (
    <div
      data-testid="stub-customer-graph-read"
      data-enabled={String(m365State.graphReadEnabled)}
      data-callback-result={callbackResult ?? ""}
      data-callback-refresh-key={String(callbackRefreshKey ?? 0)}
    />
  ),
}));
vi.mock("./Pax8Integration", () => ({
  default: () => <div data-testid="stub-pax8" />,
}));
vi.mock("../settings/TdSynnexCatalogPanel", () => ({
  default: () => <div data-testid="stub-tdsynnex" />,
}));
vi.mock("../settings/TdSynnexEcExpressPanel", () => ({
  default: () => <div data-testid="stub-tdsynnex-ec" />,
}));

// Capture the help-panel open() call so we can assert the per-tab docs link
// resolves to the right dedicated doc page. rebaseDocsUrl is a pass-through here.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("../../stores/helpStore", () => ({
  useHelpStore: { getState: () => ({ open: openMock }) },
  rebaseDocsUrl: (url: string) => url,
}));

import IntegrationsPage from "./IntegrationsPage";

const PUBLIC_RESULTS = [
  "active",
  "degraded",
  "consent_expired",
  "consent_state_mismatch",
  "consent_cancelled",
  "admin_role_required",
  "tenant_mismatch",
  "tenant_already_bound",
  "credential_unavailable",
  "identity_token_invalid",
  "application_token_invalid",
  "grant_reconciliation_unavailable",
  "grant_missing",
  "grant_unexpected",
  "manifest_stale",
  "organization_probe_failed",
  "executor_unavailable",
] as const;

describe("IntegrationsPage — M365 coexistence", () => {
  beforeEach(() => {
    scope = "partner";
    m365State.legacyEnabled = true;
    m365State.graphReadEnabled = true;
    window.history.replaceState({}, "", "/integrations#m365");
  });

  it.each([
    [false, true],
    [true, false],
    [true, true],
    [false, false],
  ])("keeps legacy=%s and Customer Graph Read=%s as sibling cards", (legacyEnabled, graphReadEnabled) => {
    m365State.legacyEnabled = legacyEnabled;
    m365State.graphReadEnabled = graphReadEnabled;
    render(<IntegrationsPage />);

    const legacy = screen.getByTestId("stub-m365");
    const graphRead = screen.getByTestId("stub-customer-graph-read");
    expect(legacy).toHaveAttribute("data-enabled", String(legacyEnabled));
    expect(graphRead).toHaveAttribute("data-enabled", String(graphReadEnabled));
    expect(legacy.parentElement).toBe(graphRead.parentElement);
  });
});

describe("IntegrationsPage — Customer Graph Read callback fragment", () => {
  beforeEach(() => {
    scope = "partner";
    orgState.currentOrgId = "11111111-1111-4111-8111-111111111111";
    orgState.jwtOrgId = null;
    window.history.replaceState({}, "", "/integrations?org=org-1#m365");
  });

  it.each(PUBLIC_RESULTS)("captures %s, selects M365, and consumes the fragment", (result) => {
    window.history.replaceState(
      {},
      "",
      `/integrations?org=org-1#m365/customer-graph-read/${result}`,
    );
    render(<IntegrationsPage />);

    expect(screen.getByTestId("stub-customer-graph-read")).toHaveAttribute(
      "data-callback-result",
      result,
    );
    expect(window.location.pathname).toBe("/integrations");
    expect(window.location.search).toBe("?org=org-1");
    expect(window.location.hash).toBe("#m365");
  });

  it("normalizes an unknown result without passing it to the UI", () => {
    window.history.replaceState(
      {},
      "",
      "/integrations?org=org-1#m365/customer-graph-read/provider_error%3Fcode%3Draw-token%26tenant%3Dsecret",
    );
    render(<IntegrationsPage />);

    expect(screen.getByTestId("stub-customer-graph-read")).toHaveAttribute(
      "data-callback-result",
      "",
    );
    expect(document.body).not.toHaveTextContent(/provider_error|raw-token|tenant=secret/i);
    expect(window.location.pathname).toBe("/integrations");
    expect(window.location.search).toBe("?org=org-1");
    expect(window.location.hash).toBe("#m365");
  });

  it("replaces callback state on hashchange and clears stale results on ordinary history entries", () => {
    render(<IntegrationsPage />);
    const graphRead = screen.getByTestId("stub-customer-graph-read");
    expect(graphRead).toHaveAttribute("data-callback-result", "");

    window.history.replaceState({}, "", "/integrations?org=org-1#m365/customer-graph-read/active");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(graphRead).toHaveAttribute("data-callback-result", "active");
    expect(window.location.hash).toBe("#m365");

    window.history.replaceState({}, "", "/integrations?org=org-1#psa");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByTestId("stub-psa")).toBeInTheDocument();

    window.history.replaceState({}, "", "/integrations?org=org-1#m365");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByTestId("stub-customer-graph-read")).toHaveAttribute(
      "data-callback-result",
      "",
    );
  });

  it("clears an Org A result on an Org B switch and scopes the next callback to B", () => {
    window.history.replaceState(
      {},
      "",
      "/integrations?org=org-a#m365/customer-graph-read/active",
    );
    const view = render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-customer-graph-read")).toHaveAttribute(
      "data-callback-result",
      "active",
    );

    orgState.currentOrgId = "22222222-2222-4222-8222-222222222222";
    view.rerender(<IntegrationsPage />);
    expect(screen.getByTestId("stub-customer-graph-read")).toHaveAttribute(
      "data-callback-result",
      "",
    );

    window.history.replaceState(
      {},
      "",
      "/integrations?org=org-b#m365/customer-graph-read/degraded",
    );
    fireEvent(window, new HashChangeEvent("hashchange"));
    const graphRead = screen.getByTestId("stub-customer-graph-read");
    expect(graphRead).toHaveAttribute("data-callback-result", "degraded");
    expect(graphRead).toHaveAttribute("data-callback-refresh-key", "2");
  });

  it("normalizes and refreshes without showing an unscoped partner callback result", () => {
    orgState.currentOrgId = null;
    scope = "partner";
    orgState.jwtOrgId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState(
      {},
      "",
      "/integrations?org=org-a#m365/customer-graph-read/active",
    );

    render(<IntegrationsPage />);

    const graphRead = screen.getByTestId("stub-customer-graph-read");
    expect(graphRead).toHaveAttribute("data-callback-result", "");
    expect(graphRead).toHaveAttribute("data-callback-refresh-key", "1");
    expect(window.location.hash).toBe("#m365");
  });

  it("uses the JWT organization fallback only for an organization-scoped session", () => {
    orgState.currentOrgId = null;
    scope = "organization";
    orgState.jwtOrgId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState(
      {},
      "",
      "/integrations?org=org-a#m365/customer-graph-read/active",
    );

    render(<IntegrationsPage />);

    expect(screen.getByTestId("stub-customer-graph-read")).toHaveAttribute(
      "data-callback-result",
      "active",
    );
  });
});

describe("IntegrationsPage — Distributors tab", () => {
  beforeEach(() => {
    scope = "partner";
    // Tab clicks now persist to window.location.hash, so reset it between tests
    // to keep them isolated (a leaked #tdsynnex-ec would pre-select this tab).
    window.location.hash = "";
  });
  afterEach(() => {
    window.location.hash = "";
  });

  it("shows a Distributors top-level tab", () => {
    render(<IntegrationsPage />);
    expect(screen.getByRole("button", { name: /Distributors/i })).toBeTruthy();
  });

  it("renders Pax8 by default and TD SYNNEX Pricing when the sub-tab is selected (partner scope)", () => {
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Distributors/i }));

    // pax8 is the default sub-tab
    expect(screen.getByTestId("stub-pax8")).toBeTruthy();
    expect(screen.queryByTestId("stub-tdsynnex-ec")).toBeNull();

    // The legacy Digital Bridge "TD SYNNEX" tab is hidden; EC Express
    // "TD SYNNEX Pricing" is the surfaced TD SYNNEX connector.
    expect(screen.queryByRole("button", { name: "TD SYNNEX" })).toBeNull();
    expect(screen.queryByTestId("stub-tdsynnex")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "TD SYNNEX Pricing" }));
    expect(screen.getByTestId("stub-tdsynnex-ec")).toBeTruthy();
    expect(screen.queryByTestId("stub-pax8")).toBeNull();
  });

  it("lets a system-scope user use the Distributors tab", () => {
    scope = "system";
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Distributors/i }));
    expect(screen.getByTestId("stub-pax8")).toBeTruthy();
    expect(screen.queryByTestId("distributors-org-scope")).toBeNull();
  });

  it("gates the Distributors tab for org-scope users with a partner-only message", () => {
    scope = "organization";
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Distributors/i }));

    expect(screen.getByTestId("distributors-org-scope")).toBeTruthy();
    // No panels and no sub-tab bar for org-scope users.
    expect(screen.queryByTestId("stub-pax8")).toBeNull();
    expect(screen.queryByTestId("stub-tdsynnex")).toBeNull();
    expect(screen.queryByRole("button", { name: "TD SYNNEX" })).toBeNull();
  });
});

// The 5 legacy /settings/integrations/* routes 301-redirect here with a hash
// (#psa, #security, #monitoring, #huntress). This is the contract that makes
// those redirects land on the right tab — guard it so a refactor of `tabs` or
// the hash initializer doesn't silently send every old bookmark to Webhooks.
describe("IntegrationsPage — URL hash deep-linking", () => {
  beforeEach(() => {
    scope = "partner";
    window.location.hash = "";
  });
  afterEach(() => {
    window.location.hash = "";
  });

  it("selects a top-level tab from the hash (#psa)", () => {
    window.location.hash = "#psa";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-psa")).toBeTruthy();
    expect(screen.queryByTestId("stub-webhooks")).toBeNull();
  });

  it("selects the Monitoring tab from #monitoring", () => {
    window.location.hash = "#monitoring";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-monitoring")).toBeTruthy();
  });

  it("selects the Notifications tab from #notifications", () => {
    window.location.hash = "#notifications";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-notifications")).toBeTruthy();
    expect(screen.queryByTestId("stub-webhooks")).toBeNull();
  });

  it("selects the Security tab (default SentinelOne sub-tab) from #security", () => {
    window.location.hash = "#security";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-security")).toBeTruthy();
    expect(screen.queryByTestId("stub-huntress")).toBeNull();
  });

  it("activates the Security tab AND Huntress sub-tab from the #huntress sub-tab hash", () => {
    window.location.hash = "#huntress";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-huntress")).toBeTruthy();
    expect(screen.queryByTestId("stub-security")).toBeNull();
  });

  it("falls back to the default tab when the hash is unknown", () => {
    window.location.hash = "#bogus";
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-webhooks")).toBeTruthy();
    expect(screen.queryByTestId("stub-psa")).toBeNull();
  });

  it("lets a valid hash override the initialTab prop", () => {
    window.location.hash = "#monitoring";
    render(<IntegrationsPage initialTab="psa" />);
    expect(screen.getByTestId("stub-monitoring")).toBeTruthy();
    expect(screen.queryByTestId("stub-psa")).toBeNull();
  });
});

// Clicking a tab must now write the URL hash so the tab is deep-linkable and
// survives a reload, and an external hash change (back/forward) must re-sync the
// active tab. This is the other half of the deep-link contract above.
describe("IntegrationsPage — writing & syncing the URL hash", () => {
  beforeEach(() => {
    scope = "partner";
    window.location.hash = "";
  });
  afterEach(() => {
    window.location.hash = "";
  });

  it("writes the tab id to the hash when a top-level tab is clicked", () => {
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Monitoring/i }));
    expect(window.location.hash).toBe("#monitoring");
  });

  it("writes the sub-tab id to the hash when a sub-tab is clicked", () => {
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Security/i }));
    fireEvent.click(screen.getByRole("button", { name: "Huntress" }));
    expect(window.location.hash).toBe("#huntress");
    expect(screen.getByTestId("stub-huntress")).toBeTruthy();
  });

  it("re-syncs the active tab when the hash changes externally (back/forward)", () => {
    render(<IntegrationsPage />);
    expect(screen.getByTestId("stub-webhooks")).toBeTruthy();

    window.location.hash = "#psa";
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByTestId("stub-psa")).toBeTruthy();
    expect(screen.queryByTestId("stub-webhooks")).toBeNull();
  });
});

// The per-tab "View documentation" link opens the help panel to the dedicated
// doc page for whichever tab is active.
describe("IntegrationsPage — per-tab documentation link", () => {
  beforeEach(() => {
    scope = "partner";
    window.location.hash = "";
    openMock.mockClear();
  });
  afterEach(() => {
    window.location.hash = "";
  });

  it("opens the active tab's dedicated doc page", () => {
    render(<IntegrationsPage />);
    // Default tab is Webhooks.
    fireEvent.click(screen.getByTestId("integrations-docs-link"));
    expect(openMock).toHaveBeenLastCalledWith(
      "https://docs.breezermm.com/features/webhooks/",
    );

    // Switching tabs points the link at that tab's doc.
    fireEvent.click(screen.getByRole("button", { name: /Security/i }));
    fireEvent.click(screen.getByTestId("integrations-docs-link"));
    expect(openMock).toHaveBeenLastCalledWith(
      "https://docs.breezermm.com/features/edr-integrations/",
    );

    fireEvent.click(screen.getByRole("button", { name: /UniFi/i }));
    fireEvent.click(screen.getByTestId("integrations-docs-link"));
    expect(openMock).toHaveBeenLastCalledWith(
      "https://docs.breezermm.com/features/unifi-integration/",
    );
  });
});
