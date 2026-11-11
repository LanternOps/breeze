import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();
let scope: "system" | "partner" | "organization" | null = "partner";

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock("../shared/Toast", () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock("@/lib/navigation", () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));
vi.mock("../../lib/authScope", () => ({
  loginPathWithNext: () => "/login?next=/integrations",
  getJwtClaims: () => ({ scope, orgId: null, partnerId: "partner-1" }),
}));

import Pax8Integration from "./Pax8Integration";

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const existingIntegration = {
  id: "pax8-1",
  partnerId: "partner-1",
  name: "Production Pax8",
  apiBaseUrl: "https://api.pax8.com",
  tokenUrl: "https://login.pax8.com/oauth/token",
  isActive: true,
  lastSyncAt: "2026-06-18T12:00:00.000Z",
  lastSyncStatus: "success",
  lastSyncError: null,
  hasClientId: true,
  hasClientSecret: true,
  hasWebhookSecret: false,
};

const breezeOrg = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Acme Corp",
};

const company = {
  pax8CompanyId: "pax8-co-1",
  pax8CompanyName: "Acme Pax8",
  status: "active",
  mappedOrgId: null,
  mappedOrgName: null,
  ignored: false,
  lastSeenAt: null,
  updatedAt: null,
};

const subscription = {
  id: "sub-1",
  pax8SubscriptionId: "pax8-sub-1",
  pax8CompanyId: "pax8-co-1",
  pax8CompanyName: "Acme Pax8",
  orgId: null,
  productId: "prod-1",
  productName: "Microsoft 365 Business",
  vendorName: "Microsoft",
  status: "active",
  billingTerm: "monthly",
  quantity: 12,
  unitPrice: "20.00",
  unitCost: "15.00",
  currencyCode: "USD",
  contractLineId: null,
  syncEnabled: null,
};

/** Mock the load fan-out: integration + (when configured) companies/subscriptions/orgs. */
function mockLoad(
  options: {
    integration?: typeof existingIntegration | null;
    companies?: unknown[];
    subscriptions?: unknown[];
  } = {},
) {
  const integration =
    options.integration === undefined ? null : options.integration;
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === "/pax8/integration") return jsonResponse({ data: integration });
    if (url === "/pax8/companies")
      return jsonResponse({ data: options.companies ?? [] });
    if (url.startsWith("/pax8/subscriptions"))
      return jsonResponse({ data: options.subscriptions ?? [] });
    if (url.startsWith("/orgs/organizations"))
      return jsonResponse({ data: [breezeOrg] });
    return jsonResponse({}, 404);
  });
}

describe("Pax8Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
  });

  it("renders the connect form (not connected) when no integration exists", async () => {
    mockLoad({ integration: null });
    render(<Pax8Integration />);

    expect(await screen.findByTestId("pax8-panel")).toBeTruthy();
    expect(screen.getByTestId("pax8-status-disconnected")).toBeTruthy();
    expect(screen.getByText("Connect Pax8")).toBeTruthy();
    // Test / Sync only show once configured.
    expect(screen.queryByTestId("pax8-test")).toBeNull();
    expect(screen.queryByTestId("pax8-sync")).toBeNull();
    // Save is disabled until both credentials are entered for a fresh integration.
    expect(
      (screen.getByTestId("pax8-save") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows configured indicators and sync status when an integration exists", async () => {
    mockLoad({ integration: existingIntegration });
    render(<Pax8Integration />);

    expect(await screen.findByTestId("pax8-status-connected")).toBeTruthy();
    expect(screen.getByTestId("pax8-has-client-id")).toBeTruthy();
    expect(screen.getByTestId("pax8-has-client-secret")).toBeTruthy();
    expect(screen.getByTestId("pax8-sync-status")).toBeTruthy();
    expect(screen.getByTestId("pax8-sync-status-value").textContent).toContain(
      "success",
    );
    // Secrets are never re-populated into the inputs.
    expect(
      (screen.getByTestId("pax8-client-id") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByTestId("pax8-client-secret") as HTMLInputElement).value,
    ).toBe("");
  });

  it("connects a fresh integration via runAction with both credentials", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/pax8/integration" && init?.method === "POST") {
          return jsonResponse(
            { ...existingIntegration, lastSyncStatus: null, lastSyncAt: null },
            201,
          );
        }
        if (url === "/pax8/integration") return jsonResponse({ data: null });
        if (url === "/pax8/companies") return jsonResponse({ data: [] });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg] });
        return jsonResponse({}, 404);
      },
    );

    render(<Pax8Integration />);
    await screen.findByTestId("pax8-panel");

    fireEvent.change(screen.getByTestId("pax8-client-id"), {
      target: { value: "client-abc" },
    });
    fireEvent.change(screen.getByTestId("pax8-client-secret"), {
      target: { value: "secret-xyz" },
    });
    fireEvent.click(screen.getByTestId("pax8-save"));

    await waitFor(() => {
      expect(
        fetchWithAuth.mock.calls.some(
          ([url, init]) =>
            url === "/pax8/integration" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const postCall = fetchWithAuth.mock.calls.find(
      ([url, init]) => url === "/pax8/integration" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: "Pax8",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("updates an existing integration without re-sending secrets when fields are blank", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/pax8/integration" && init?.method === "POST")
          return jsonResponse(existingIntegration, 200);
        if (url === "/pax8/integration")
          return jsonResponse({ data: existingIntegration });
        if (url === "/pax8/companies") return jsonResponse({ data: [] });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg] });
        return jsonResponse({}, 404);
      },
    );

    render(<Pax8Integration />);
    await screen.findByTestId("pax8-status-connected");

    const save = screen.getByTestId("pax8-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false); // existing integration may save with blank credentials
    fireEvent.click(save);

    await waitFor(() => {
      expect(
        fetchWithAuth.mock.calls.some(
          ([url, init]) =>
            url === "/pax8/integration" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const postCall = fetchWithAuth.mock.calls.find(
      ([url, init]) => url === "/pax8/integration" && init?.method === "POST",
    );
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body).not.toHaveProperty("clientId");
    expect(body).not.toHaveProperty("clientSecret");
    expect(body).toMatchObject({ name: "Production Pax8" });
  });

  it("surfaces a successful connection test", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/pax8/integration/test" && init?.method === "POST")
          return jsonResponse({ success: true, data: {} });
        if (url === "/pax8/integration")
          return jsonResponse({ data: existingIntegration });
        if (url === "/pax8/companies") return jsonResponse({ data: [] });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg] });
        return jsonResponse({}, 404);
      },
    );

    render(<Pax8Integration />);
    await screen.findByTestId("pax8-status-connected");
    fireEvent.click(screen.getByTestId("pax8-test"));

    expect(await screen.findByTestId("pax8-test-result")).toHaveTextContent(
      "Connection test succeeded.",
    );
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("surfaces a failed connection test (HTTP 502)", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/pax8/integration/test" && init?.method === "POST") {
          return jsonResponse(
            { success: false, error: "Invalid Pax8 credentials" },
            502,
          );
        }
        if (url === "/pax8/integration")
          return jsonResponse({ data: existingIntegration });
        if (url === "/pax8/companies") return jsonResponse({ data: [] });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg] });
        return jsonResponse({}, 404);
      },
    );

    render(<Pax8Integration />);
    await screen.findByTestId("pax8-status-connected");
    fireEvent.click(screen.getByTestId("pax8-test"));

    await waitFor(() =>
      expect(screen.getByTestId("pax8-test-result")).toHaveTextContent(
        "Invalid Pax8 credentials",
      ),
    );
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("triggers a sync via runAction and surfaces success", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/pax8/sync" && init?.method === "POST")
          return jsonResponse({ queued: true, jobId: "job-1" });
        if (url === "/pax8/integration")
          return jsonResponse({ data: existingIntegration });
        if (url === "/pax8/companies") return jsonResponse({ data: [] });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg] });
        return jsonResponse({}, 404);
      },
    );

    render(<Pax8Integration />);
    await screen.findByTestId("pax8-status-connected");
    fireEvent.click(screen.getByTestId("pax8-sync"));

    await waitFor(() => {
      expect(
        fetchWithAuth.mock.calls.some(
          ([url, init]) => url === "/pax8/sync" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("maps a Pax8 company to a Breeze org and posts the mapping", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/pax8/companies/map" && init?.method === "POST") {
          return jsonResponse({
            data: {
              ...company,
              mappedOrgId: breezeOrg.id,
              mappedOrgName: breezeOrg.name,
            },
          });
        }
        if (url === "/pax8/integration")
          return jsonResponse({ data: existingIntegration });
        if (url === "/pax8/companies") return jsonResponse({ data: [company] });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg] });
        return jsonResponse({}, 404);
      },
    );

    render(<Pax8Integration />);
    await screen.findByTestId("pax8-companies-table");

    fireEvent.change(screen.getByTestId("pax8-company-map-pax8-co-1"), {
      target: { value: breezeOrg.id },
    });

    await waitFor(() => {
      expect(
        fetchWithAuth.mock.calls.some(
          ([url, init]) =>
            url === "/pax8/companies/map" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const mapCall = fetchWithAuth.mock.calls.find(
      ([url, init]) => url === "/pax8/companies/map" && init?.method === "POST",
    );
    expect(JSON.parse(String(mapCall?.[1]?.body))).toMatchObject({
      integrationId: "pax8-1",
      pax8CompanyId: "pax8-co-1",
      orgId: breezeOrg.id,
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("renders the read-only subscriptions list", async () => {
    mockLoad({
      integration: existingIntegration,
      subscriptions: [subscription],
    });
    render(<Pax8Integration />);

    expect(await screen.findByTestId("pax8-subscriptions-table")).toBeTruthy();
    expect(screen.getByText("Microsoft 365 Business")).toBeTruthy();
    expect(screen.getByText("USD 15.00")).toBeTruthy();
  });

  it("shows a partner-scope-only message for org-scope users and never calls the API", async () => {
    scope = "organization";
    mockLoad({ integration: existingIntegration });
    render(<Pax8Integration />);

    expect(await screen.findByTestId("pax8-org-scope")).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  describe("suggested matches", () => {
    const suggestedRow = {
      ...company,
      firstSeenAt: "2026-06-01T00:00:00.000Z",
      suggestion: {
        status: "match",
        orgId: breezeOrg.id,
        orgName: breezeOrg.name,
        tier: "exact",
        matchKey: "acme",
      },
    };
    const mappedRow = {
      ...suggestedRow,
      mappedOrgId: breezeOrg.id,
      mappedOrgName: breezeOrg.name,
      suggestion: null,
    };
    const summaryOf = (unmapped: number, suggested: number, newUnmapped = 0) => ({
      unmapped,
      suggested,
      newUnmapped,
    });

    function mockSuggest(opts: {
      companiesQueue: Array<{ data: unknown[]; summary?: unknown }>;
      onPost?: (url: string, init: RequestInit) => Response | undefined;
    }) {
      let n = 0;
      fetchWithAuth.mockImplementation(
        async (url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            const r = opts.onPost?.(url, init);
            if (r) return r;
          }
          if (url === "/pax8/integration")
            return jsonResponse({ data: existingIntegration });
          if (url.startsWith("/pax8/companies")) {
            const entry =
              opts.companiesQueue[Math.min(n, opts.companiesQueue.length - 1)];
            n += 1;
            return jsonResponse({
              integrationId: "pax8-1",
              summary: summaryOf(1, 1),
              ...entry,
            });
          }
          if (url.startsWith("/pax8/subscriptions"))
            return jsonResponse({ data: [] });
          if (url.startsWith("/orgs/organizations"))
            return jsonResponse({ data: [breezeOrg] });
          return jsonResponse({}, 404);
        },
      );
    }
    const postsTo = (path: string) =>
      fetchWithAuth.mock.calls.filter(
        ([url, init]) => url === path && init?.method === "POST",
      );

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the chip, summary and review count for a match row", async () => {
      mockSuggest({ companiesQueue: [{ data: [suggestedRow] }] });
      render(<Pax8Integration />);
      expect(
        await screen.findByTestId("pax8-company-suggestion-pax8-co-1"),
      ).toHaveTextContent("Acme Corp");
      expect(screen.getByTestId("pax8-mapping-summary")).toHaveTextContent(
        "1 unmapped · 1 suggested",
      );
      expect(screen.getByTestId("pax8-review-suggestions")).toHaveTextContent(
        "Review 1 suggested match",
      );
    });

    it("after mapping, the select shows the new org and the chip is gone", async () => {
      mockSuggest({
        companiesQueue: [
          { data: [suggestedRow] },
          { data: [mappedRow], summary: summaryOf(0, 0) },
        ],
        onPost: (url) =>
          url === "/pax8/companies/map"
            ? jsonResponse({ data: { ...company, orgId: breezeOrg.id } })
            : undefined,
      });
      render(<Pax8Integration />);
      await screen.findByTestId("pax8-company-suggestion-pax8-co-1");

      fireEvent.change(screen.getByTestId("pax8-company-map-pax8-co-1"), {
        target: { value: breezeOrg.id },
      });

      await waitFor(() =>
        expect(
          (screen.getByTestId("pax8-company-map-pax8-co-1") as HTMLSelectElement)
            .value,
        ).toBe(breezeOrg.id),
      );
      await waitFor(() =>
        expect(
          screen.queryByTestId("pax8-company-suggestion-pax8-co-1"),
        ).toBeNull(),
      );
    });

    it("accept posts source=suggestion", async () => {
      mockSuggest({
        companiesQueue: [{ data: [suggestedRow] }, { data: [mappedRow] }],
        onPost: (url) =>
          url === "/pax8/companies/map" ? jsonResponse({ data: {} }) : undefined,
      });
      render(<Pax8Integration />);
      fireEvent.click(
        await screen.findByTestId("pax8-company-suggestion-pax8-co-1-accept"),
      );
      await waitFor(() => expect(postsTo("/pax8/companies/map")).toHaveLength(1));
      expect(
        JSON.parse(String(postsTo("/pax8/companies/map")[0][1].body)),
      ).toMatchObject({
        integrationId: "pax8-1",
        pax8CompanyId: "pax8-co-1",
        orgId: breezeOrg.id,
        source: "suggestion",
      });
    });

    it("ambiguous row narrows the dropdown", async () => {
      const otherOrg = { id: "00000000-0000-4000-8000-000000000002", name: "Other" };
      fetchWithAuth.mockImplementation(async (url: string) => {
        if (url === "/pax8/integration")
          return jsonResponse({ data: existingIntegration });
        if (url.startsWith("/pax8/companies"))
          return jsonResponse({
            integrationId: "pax8-1",
            summary: summaryOf(1, 0),
            data: [
              {
                ...company,
                firstSeenAt: "2026-06-01T00:00:00.000Z",
                suggestion: {
                  status: "ambiguous",
                  candidates: [{ orgId: breezeOrg.id, orgName: breezeOrg.name }],
                  tier: "exact",
                  matchKey: "acme",
                },
              },
            ],
          });
        if (url.startsWith("/pax8/subscriptions"))
          return jsonResponse({ data: [] });
        if (url.startsWith("/orgs/organizations"))
          return jsonResponse({ data: [breezeOrg, otherOrg] });
        return jsonResponse({}, 404);
      });
      render(<Pax8Integration />);
      expect(
        await screen.findByTestId("pax8-company-suggestion-pax8-co-1"),
      ).toHaveTextContent("1 possible match");
      expect(
        screen.queryByTestId("pax8-company-suggestion-pax8-co-1-accept"),
      ).toBeNull();
      const select = screen.getByTestId(
        "pax8-company-map-pax8-co-1",
      ) as HTMLSelectElement;
      await waitFor(() =>
        expect(Array.from(select.options).map((o) => o.value)).toEqual([
          "",
          breezeOrg.id,
        ]),
      );
    });

    it("a contested row shows alsoMatches without Accept", async () => {
      mockSuggest({
        companiesQueue: [
          {
            data: [
              {
                ...suggestedRow,
                suggestion: {
                  status: "contested",
                  orgId: breezeOrg.id,
                  orgName: breezeOrg.name,
                  tier: "exact",
                  matchKey: "acme",
                  contestedWith: [
                    { pax8CompanyId: "x", pax8CompanyName: "Acme Two" },
                    { pax8CompanyId: "y", pax8CompanyName: "Acme Three" },
                  ],
                },
              },
            ],
          },
        ],
      });
      render(<Pax8Integration />);
      expect(
        await screen.findByTestId("pax8-company-suggestion-pax8-co-1"),
      ).toHaveTextContent("Also matches Acme Two, Acme Three");
      expect(
        screen.queryByTestId("pax8-company-suggestion-pax8-co-1-accept"),
      ).toBeNull();
    });

    const twoRows = [
      suggestedRow,
      {
        ...suggestedRow,
        pax8CompanyId: "pax8-co-2",
        pax8CompanyName: "Beta Pax8",
        suggestion: { ...suggestedRow.suggestion, orgId: "org-b", orgName: "Beta" },
      },
    ];

    it("bulk confirm posts only checked items with expectedOrgId null", async () => {
      mockSuggest({
        companiesQueue: [{ data: twoRows }, { data: [] }],
        onPost: (url) =>
          url === "/pax8/companies/map-bulk"
            ? jsonResponse({ data: { mapped: 1 } })
            : undefined,
      });
      render(<Pax8Integration />);
      fireEvent.click(await screen.findByTestId("pax8-review-suggestions"));
      fireEvent.click(await screen.findByTestId("pax8-review-item-pax8-co-2"));
      fireEvent.click(screen.getByTestId("pax8-review-confirm"));
      await waitFor(() =>
        expect(postsTo("/pax8/companies/map-bulk")).toHaveLength(1),
      );
      expect(
        JSON.parse(String(postsTo("/pax8/companies/map-bulk")[0][1].body)),
      ).toEqual({
        integrationId: "pax8-1",
        items: [
          { pax8CompanyId: "pax8-co-1", orgId: breezeOrg.id, expectedOrgId: null },
        ],
      });
      await waitFor(() =>
        expect(screen.queryByTestId("pax8-review-modal")).toBeNull(),
      );
    });

    it("409 STALE_REVIEW reloads companies and shows the stale notice", async () => {
      mockSuggest({
        companiesQueue: [{ data: twoRows }, { data: [twoRows[1]] }],
        onPost: (url) =>
          url === "/pax8/companies/map-bulk"
            ? jsonResponse(
                {
                  error: "stale",
                  code: "STALE_REVIEW",
                  pax8CompanyIds: ["pax8-co-1"],
                },
                409,
              )
            : undefined,
      });
      render(<Pax8Integration />);
      fireEvent.click(await screen.findByTestId("pax8-review-suggestions"));
      fireEvent.click(await screen.findByTestId("pax8-review-confirm"));

      expect(await screen.findByTestId("pax8-review-stale")).toHaveTextContent(
        "Some rows changed since you opened this review.",
      );
      // Modal stays open with the reloaded rows only.
      await waitFor(() =>
        expect(screen.queryByTestId("pax8-review-item-pax8-co-1")).toBeNull(),
      );
      expect(screen.getByTestId("pax8-review-item-pax8-co-2")).toBeTruthy();
      // runAction's own error toast is suppressed; no raw error toast on top.
      expect(
        showToast.mock.calls.filter(([a]) => a?.type === "error"),
      ).toHaveLength(0);
    });

    it("sync polls integration until lastSyncAt changes then shows \"2 new since last sync\"", async () => {
      let integrationGets = 0;
      let companiesGets = 0;
      fetchWithAuth.mockImplementation(
        async (url: string, init?: RequestInit) => {
          if (url === "/pax8/sync" && init?.method === "POST")
            return jsonResponse({ queued: true });
          if (url === "/pax8/integration") {
            integrationGets += 1;
            // load = 1; polls 2 and 3 unchanged; poll 4 changed.
            return jsonResponse({
              data:
                integrationGets >= 4
                  ? { ...existingIntegration, lastSyncAt: "2026-06-19T12:00:00.000Z" }
                  : existingIntegration,
            });
          }
          if (url.startsWith("/pax8/companies")) {
            companiesGets += 1;
            const extra =
              companiesGets > 1
                ? [
                    { ...suggestedRow, pax8CompanyId: "n1" },
                    { ...suggestedRow, pax8CompanyId: "n2" },
                  ]
                : [];
            return jsonResponse({
              integrationId: "pax8-1",
              summary: summaryOf(3, 0, 2),
              data: [suggestedRow, ...extra],
            });
          }
          if (url.startsWith("/pax8/subscriptions"))
            return jsonResponse({ data: [] });
          if (url.startsWith("/orgs/organizations"))
            return jsonResponse({ data: [breezeOrg] });
          return jsonResponse({}, 404);
        },
      );
      render(<Pax8Integration />);
      await screen.findByTestId("pax8-status-connected");

      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
      });
      fireEvent.click(screen.getByTestId("pax8-sync"));
      await vi.advanceTimersByTimeAsync(50);
      expect(screen.queryByTestId("pax8-sync-new-companies")).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.queryByTestId("pax8-sync-new-companies")).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(50);
      expect(screen.getByTestId("pax8-sync-new-companies")).toHaveTextContent(
        "2 new since last sync",
      );
    });

    describe("review fixes", () => {
      const baseHandler = (
        overrides: (url: string, init?: RequestInit) => Response | undefined,
        counters: { integrationGets: number; companiesGets: number },
      ) =>
        fetchWithAuth.mockImplementation(
          async (url: string, init?: RequestInit) => {
            const o = overrides(url, init);
            if (o) return o;
            if (url === "/pax8/integration") {
              counters.integrationGets += 1;
              return jsonResponse({ data: existingIntegration });
            }
            if (url.startsWith("/pax8/companies")) {
              counters.companiesGets += 1;
              return jsonResponse({
                integrationId: "pax8-1",
                summary: summaryOf(1, 1),
                data: [suggestedRow],
              });
            }
            if (url.startsWith("/pax8/subscriptions"))
              return jsonResponse({ data: [] });
            if (url.startsWith("/orgs/organizations"))
              return jsonResponse({ data: [breezeOrg] });
            return jsonResponse({}, 404);
          },
        );
      const toastWith = (type: string, text: string) =>
        showToast.mock.calls.some(
          ([a]) => a?.type === type && String(a.message).includes(text),
        );
      const syncOk = (url: string, init?: RequestInit) =>
        url === "/pax8/sync" && init?.method === "POST"
          ? jsonResponse({ queued: true })
          : undefined;

      it("a sync poll timeout warns and shows no new-companies pill", async () => {
        baseHandler(syncOk, { integrationGets: 0, companiesGets: 0 });
        render(<Pax8Integration />);
        await screen.findByTestId("pax8-status-connected");
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout"],
          shouldAdvanceTime: true,
        });
        fireEvent.click(screen.getByTestId("pax8-sync"));
        await vi.advanceTimersByTimeAsync(3000 * 41);
        await vi.advanceTimersByTimeAsync(50);
        expect(toastWith("warning", "still running")).toBe(true);
        expect(screen.queryByTestId("pax8-sync-new-companies")).toBeNull();
      });

      it("unmounting mid-poll stops further integration GETs", async () => {
        const counters = { integrationGets: 0, companiesGets: 0 };
        baseHandler(syncOk, counters);
        const view = render(<Pax8Integration />);
        await screen.findByTestId("pax8-status-connected");
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout"],
          shouldAdvanceTime: true,
        });
        fireEvent.click(screen.getByTestId("pax8-sync"));
        await vi.advanceTimersByTimeAsync(3100);
        const atUnmount = counters.integrationGets;
        expect(atUnmount).toBeGreaterThan(1);
        view.unmount();
        await vi.advanceTimersByTimeAsync(20000);
        expect(counters.integrationGets).toBe(atUnmount);
      });

      it("a successful map with a non-OK companies refetch warns, not 'failed to map'", async () => {
        const counters = { integrationGets: 0, companiesGets: 0 };
        baseHandler((url, init) => {
          if (url === "/pax8/companies/map" && init?.method === "POST")
            return jsonResponse({ data: {} });
          if (url.startsWith("/pax8/companies") && counters.companiesGets >= 1)
            return jsonResponse({ error: "boom" }, 500);
          return undefined;
        }, counters);
        render(<Pax8Integration />);
        fireEvent.click(
          await screen.findByTestId("pax8-company-suggestion-pax8-co-1-accept"),
        );
        await waitFor(() =>
          expect(toastWith("warning", "could not be refreshed")).toBe(true),
        );
        expect(toastWith("error", "Failed to map")).toBe(false);
      });

      it("a successful map whose refetch throws also warns, not 'failed to map'", async () => {
        let mapped = false;
        baseHandler(
          (url, init) => {
            if (url === "/pax8/companies/map" && init?.method === "POST") {
              mapped = true;
              return jsonResponse({ data: {} });
            }
            if (url.startsWith("/pax8/companies") && mapped)
              throw new Error("network down");
            return undefined;
          },
          { integrationGets: 0, companiesGets: 0 },
        );
        render(<Pax8Integration />);
        fireEvent.click(
          await screen.findByTestId("pax8-company-suggestion-pax8-co-1-accept"),
        );
        await waitFor(() =>
          expect(toastWith("warning", "could not be refreshed")).toBe(true),
        );
        expect(toastWith("error", "Failed to map")).toBe(false);
      });

      it("bulk success toasts a plural count", async () => {
        baseHandler(
          (url, init) =>
            url === "/pax8/companies/map-bulk" && init?.method === "POST"
              ? jsonResponse({ data: { mapped: 1 } })
              : undefined,
          { integrationGets: 0, companiesGets: 0 },
        );
        render(<Pax8Integration />);
        fireEvent.click(await screen.findByTestId("pax8-review-suggestions"));
        fireEvent.click(await screen.findByTestId("pax8-review-confirm"));
        await waitFor(() =>
          expect(toastWith("success", "1 company mapped")).toBe(true),
        );
      });

      it("bulk 400 INVALID_TARGET toasts an error, keeps the modal open, no stale notice", async () => {
        baseHandler(
          (url, init) =>
            url === "/pax8/companies/map-bulk" && init?.method === "POST"
              ? jsonResponse({ error: "bad target", code: "INVALID_TARGET" }, 400)
              : undefined,
          { integrationGets: 0, companiesGets: 0 },
        );
        render(<Pax8Integration />);
        fireEvent.click(await screen.findByTestId("pax8-review-suggestions"));
        fireEvent.click(await screen.findByTestId("pax8-review-confirm"));
        await waitFor(() =>
          expect(showToast.mock.calls.some(([a]) => a?.type === "error")).toBe(
            true,
          ),
        );
        expect(screen.getByTestId("pax8-review-modal")).toBeTruthy();
        expect(screen.queryByTestId("pax8-review-stale")).toBeNull();
      });

      it("a 409 STALE_REVIEW whose refetch throws never escapes confirmBulk", async () => {
        let stale = false;
        baseHandler(
          (url, init) => {
            if (url === "/pax8/companies/map-bulk" && init?.method === "POST") {
              stale = true;
              return jsonResponse({ error: "stale", code: "STALE_REVIEW" }, 409);
            }
            if (url.startsWith("/pax8/companies") && stale)
              throw new Error("network down");
            return undefined;
          },
          { integrationGets: 0, companiesGets: 0 },
        );
        render(<Pax8Integration />);
        fireEvent.click(await screen.findByTestId("pax8-review-suggestions"));
        fireEvent.click(await screen.findByTestId("pax8-review-confirm"));
        await waitFor(() =>
          expect(toastWith("warning", "could not be refreshed")).toBe(true),
        );
        expect(toastWith("error", "Failed to map")).toBe(false);
      });
    });
  });
});
