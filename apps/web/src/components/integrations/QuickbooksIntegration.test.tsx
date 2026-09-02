import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import QuickbooksIntegration from "./QuickbooksIntegration";

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const disconnected = {
  status: "disconnected",
  environment: null,
  pushMode: "auto",
  connectedAt: null,
  lastError: null,
};
const connected = {
  status: "connected",
  environment: "production",
  pushMode: "auto",
  connectedAt: "2026-06-23T00:00:00Z",
  lastError: null,
};

describe("QuickbooksIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
    window.history.replaceState({}, "", "/integrations");
  });

  it("renders the not-connected state with a Connect button", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(disconnected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(
      await screen.findByTestId("quickbooks-status-disconnected"),
    ).toBeTruthy();
    expect(screen.getByTestId("quickbooks-connect")).toBeTruthy();
    expect(screen.queryByTestId("quickbooks-disconnect")).toBeNull();
  });

  it("renders the connected state with disconnect and push-mode controls", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(connected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(
      await screen.findByTestId("quickbooks-status-connected"),
    ).toBeTruthy();
    expect(screen.getByTestId("quickbooks-disconnect")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode-auto")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode-manual")).toBeTruthy();
  });

  it("switching push mode PATCHes the settings endpoint", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({ ...connected, pushMode: "manual" });
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-pushmode-manual"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/settings",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("Connect requests an authUrl from the connect endpoint", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(disconnected);
      if (url === "/accounting/quickbooks/connect") {
        return jsonResponse({
          authUrl: "https://appcenter.intuit.com/connect/oauth2?state=x",
        });
      }
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-connect"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/connect",
      ),
    );
  });

  it("renders the reauth-required state with a Reconnect CTA and last error", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") {
        return jsonResponse({
          status: "reauth_required",
          environment: "production",
          pushMode: "auto",
          connectedAt: "2026-06-23T00:00:00Z",
          lastError: "refresh token expired",
        });
      }
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-status-reauth")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-last-error")).toHaveTextContent(
      "refresh token expired",
    );
    expect(screen.getByTestId("quickbooks-connect")).toHaveTextContent(
      "Reconnect",
    );
    expect(screen.queryByTestId("quickbooks-disconnect")).toBeNull();
  });

  it("shows a partner-scope-only message for org-scope users and never calls the API", async () => {
    scope = "organization";

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-org-scope")).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("renders the home currency and an unknown multi-currency line before a refresh", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks")
        return jsonResponse({ ...connected, homeCurrency: "USD" });
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-home-currency")).toHaveTextContent("USD");
    // GET /accounting/quickbooks does not carry the realm flag — it is only
    // learned from a settings refresh, so "unknown" is the honest initial read.
    expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("Unknown");
  });

  it("Refresh settings POSTs the refresh route and re-renders currency + multi-currency", async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/accounting/quickbooks/settings/refresh" && init?.method === "POST") {
        return jsonResponse({ homeCurrency: "GBP", multiCurrencyEnabled: true });
      }
      if (url === "/accounting/quickbooks")
        return jsonResponse({ ...connected, homeCurrency: "USD" });
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-settings-refresh"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/settings/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("quickbooks-home-currency")).toHaveTextContent("GBP"),
    );
    expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("Yes");
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("renders a multi-currency No when the realm reports the feature off", async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/accounting/quickbooks/settings/refresh" && init?.method === "POST") {
        return jsonResponse({ homeCurrency: "USD", multiCurrencyEnabled: false });
      }
      if (url === "/accounting/quickbooks") return jsonResponse(connected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-settings-refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("No"),
    );
  });
});
