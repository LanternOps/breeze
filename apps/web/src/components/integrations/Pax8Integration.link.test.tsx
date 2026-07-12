import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchWithAuth = vi.fn();
const navigateTo = vi.fn();
vi.mock("../../stores/auth", () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
}));
vi.mock("@/lib/navigation", () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));
vi.mock("../../lib/authScope", () => ({
  loginPathWithNext: () => "/login?next=/integrations",
  getJwtClaims: () => ({
    scope: "partner",
    orgId: null,
    partnerId: "partner-1",
  }),
}));
vi.mock("./LinkSubscriptionPicker", () => ({
  default: ({ onDone }: { onDone: () => void }) => (
    <button data-testid="mock-picker-done" onClick={onDone}>
      picker
    </button>
  ),
}));

import Pax8Integration from "./Pax8Integration";

const ok = (data: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ data, ...extra }), { status: 200 });

const integration = {
  id: "int-1",
  partnerId: "partner-1",
  name: "Production Pax8",
  apiBaseUrl: "https://api.pax8.example",
  tokenUrl: "https://login.pax8.example/oauth/token",
  isActive: true,
  lastSyncAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  hasClientId: true,
  hasClientSecret: true,
  hasWebhookSecret: false,
};

const subscriptions = (linked = true) => [
  {
    id: "sub-unlinked",
    pax8SubscriptionId: "pax8-sub-unlinked",
    pax8CompanyId: "pax8-co-1",
    pax8CompanyName: "Acme Pax8",
    orgId: "org-1",
    productId: "item-a",
    productName: "Item A",
    vendorName: "Vendor A",
    status: "active",
    billingTerm: "monthly",
    quantity: 2,
    unitPrice: "20.00",
    unitCost: "15.00",
    currencyCode: "USD",
    contractLineId: null,
    syncEnabled: null,
  },
  {
    id: "sub-linked",
    pax8SubscriptionId: "pax8-sub-linked",
    pax8CompanyId: "pax8-co-1",
    pax8CompanyName: "Acme Pax8",
    orgId: "org-1",
    productId: "item-b",
    productName: "Item B",
    vendorName: "Vendor B",
    status: "active",
    billingTerm: "monthly",
    quantity: 3,
    unitPrice: "30.00",
    unitCost: "22.00",
    currencyCode: "USD",
    contractLineId: "line-1",
    syncEnabled: linked,
  },
];

// Route fetchWithAuth by URL+method so the component's initial load resolves and
// the subscriptions table renders with one linked + one unlinked row.
function routeFetch(linked = true) {
  fetchWithAuth.mockImplementation(
    (url: string, opts?: { method?: string }) => {
      if (url === "/pax8/subscriptions/link")
        return Promise.resolve(ok({ unlinked: opts?.method === "DELETE" }));
      if (url.startsWith("/pax8/integration"))
        return Promise.resolve(ok(integration));
      if (url.startsWith("/pax8/companies")) return Promise.resolve(ok([]));
      if (url.startsWith("/pax8/subscriptions"))
        return Promise.resolve(ok(subscriptions(linked)));
      if (url.startsWith("/orgs/organizations"))
        return Promise.resolve(ok([{ id: "org-1", name: "Acme" }]));
      return Promise.resolve(ok(null));
    },
  );
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe("Pax8Integration subscription actions", () => {
  it("unlinks a linked subscription via DELETE", async () => {
    routeFetch(true);
    render(<Pax8Integration />);
    await waitFor(() =>
      screen.getByTestId("pax8-subscription-unlink-sub-linked"),
    );
    fireEvent.click(screen.getByTestId("pax8-subscription-unlink-sub-linked"));
    await waitFor(() => {
      const del = fetchWithAuth.mock.calls.find(
        ([u, o]) => u === "/pax8/subscriptions/link" && o?.method === "DELETE",
      );
      expect(del).toBeTruthy();
      expect(JSON.parse((del![1] as { body: string }).body)).toMatchObject({
        integrationId: "int-1",
        subscriptionSnapshotId: "sub-linked",
      });
    });
  });

  it("opens the picker for an unlinked, mapped subscription", async () => {
    routeFetch(true);
    render(<Pax8Integration />);
    await waitFor(() =>
      screen.getByTestId("pax8-subscription-link-sub-unlinked"),
    );
    fireEvent.click(screen.getByTestId("pax8-subscription-link-sub-unlinked"));
    await waitFor(() => screen.getByTestId("mock-picker-done"));
  });

  it("pauses sync by POSTing syncEnabled:false for a currently-syncing link", async () => {
    routeFetch(true); // sub-linked starts syncEnabled: true
    render(<Pax8Integration />);
    await waitFor(() =>
      screen.getByTestId("pax8-subscription-togglesync-sub-linked"),
    );
    fireEvent.click(
      screen.getByTestId("pax8-subscription-togglesync-sub-linked"),
    );
    await waitFor(() => {
      const post = fetchWithAuth.mock.calls.find(
        ([u, o]) => u === "/pax8/subscriptions/link" && o?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as { body: string }).body)).toMatchObject({
        integrationId: "int-1",
        subscriptionSnapshotId: "sub-linked",
        contractLineId: "line-1",
        syncEnabled: false,
      });
    });
  });

  it('shows "Map company first" and no Link action for an unmapped subscription', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith("/pax8/integration"))
        return Promise.resolve(ok(integration));
      if (url.startsWith("/pax8/companies")) return Promise.resolve(ok([]));
      if (url.startsWith("/pax8/subscriptions"))
        return Promise.resolve(
          ok([{ ...subscriptions(true)[0], id: "sub-unmapped", orgId: null }]),
        );
      if (url.startsWith("/orgs/organizations"))
        return Promise.resolve(ok([{ id: "org-1", name: "Acme" }]));
      return Promise.resolve(ok(null));
    });
    render(<Pax8Integration />);
    await waitFor(() => screen.getByTestId("pax8-subscription-sub-unmapped"));
    expect(
      screen.queryByTestId("pax8-subscription-link-sub-unmapped"),
    ).toBeNull();
    expect(screen.getByText("Map company first")).toBeTruthy();
  });
});
