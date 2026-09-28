import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import M365Integration from "./M365Integration";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(
  payload: unknown,
  ok = true,
  status = ok ? 200 : 500,
): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe("M365Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a calm not-enabled state (no red error, no connect form) when the feature flag is off (404 not enabled)", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(
        { error: "Microsoft 365 integration is not enabled" },
        false,
        404,
      ),
    );

    render(<M365Integration />);

    await waitFor(() =>
      expect(screen.getByTestId("m365-not-enabled")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        /Legacy direct connection is not enabled on this instance/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/M365_ENABLED/)).toBeInTheDocument();

    // The red "Failed to load connection" error is NOT rendered.
    expect(
      screen.queryByText(/Failed to load connection/i),
    ).not.toBeInTheDocument();

    // The connect form (client secret) is hidden.
    expect(screen.queryByText(/Client secret/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save & verify/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the red error UI for a genuine (non-404) load failure", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse({ error: "Boom" }, false, 500),
    );

    render(<M365Integration />);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to load connection \(500\): Boom/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("m365-not-enabled")).not.toBeInTheDocument();
    // Connect form still renders for a real error.
    expect(
      screen.getByRole("button", { name: /Save & verify/i }),
    ).toBeInTheDocument();
  });

  it("keeps the red error UI for a network error", async () => {
    fetchWithAuthMock.mockRejectedValue(new Error("Network down"));

    render(<M365Integration />);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to load connection: Network down/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("m365-not-enabled")).not.toBeInTheDocument();
  });
  describe("connected legacy card", () => {
    const CONNECTED = {
      connected: true,
      tenantId: "44444444-4444-4444-8444-444444444444",
      clientId: "55555555-5555-4555-8555-555555555555",
      displayName: "Northwind Traders",
      status: "active",
      lastVerifiedAt: "2026-07-10T10:00:00.000Z",
    };

    it("never renders an h1 — the page owns the only one", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(CONNECTED));
      render(<M365Integration />);
      expect(
        await screen.findByRole("heading", { level: 2, name: "Microsoft 365" }),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
      expect(screen.getByRole("heading", { level: 3, name: "Connection" })).toBeInTheDocument();
    });

    it("never renders an h1 in the not-enabled state either", async () => {
      fetchWithAuthMock.mockResolvedValue(
        makeResponse({ error: "Microsoft 365 integration is not enabled" }, false, 404),
      );
      render(<M365Integration />);
      await screen.findByTestId("m365-not-enabled");
      expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
      expect(screen.getByRole("heading", { level: 2, name: "Microsoft 365" })).toBeInTheDocument();
    });

    it("asks for confirmation before disconnecting and does nothing when declined", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      fetchWithAuthMock.mockResolvedValue(makeResponse(CONNECTED));
      render(<M365Integration />);
      fireEvent.click(await screen.findByRole("button", { name: /Disconnect/i }));
      expect(confirm).toHaveBeenCalledWith(
        expect.stringMatching(/Breeze deletes the stored app registration credentials/),
      );
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
      expect(fetchWithAuthMock).not.toHaveBeenCalledWith("/m365/connection", { method: "DELETE" });
    });

    it("disconnects once confirmed", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      fetchWithAuthMock
        .mockResolvedValueOnce(makeResponse(CONNECTED))
        .mockResolvedValueOnce(makeResponse({ connected: false }));
      render(<M365Integration />);
      fireEvent.click(await screen.findByRole("button", { name: /Disconnect/i }));
      await waitFor(() =>
        expect(fetchWithAuthMock).toHaveBeenCalledWith("/m365/connection", { method: "DELETE" }),
      );
      expect(await screen.findByRole("button", { name: /Save & verify/i })).toBeInTheDocument();
    });

    it("shows the Legacy badge and precedence note only when asked to", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(CONNECTED));
      const view = render(<M365Integration />);
      await screen.findByRole("heading", { level: 2, name: /Microsoft 365/ });
      expect(screen.queryByTestId("m365-legacy-badge")).not.toBeInTheDocument();
      expect(screen.queryByTestId("m365-legacy-precedence-note")).not.toBeInTheDocument();

      view.rerender(<M365Integration legacyBadge showPrecedenceNote />);
      expect(screen.getByTestId("m365-legacy-badge")).toHaveTextContent("Legacy");
      expect(screen.getByTestId("m365-legacy-precedence-note")).toBeInTheDocument();
    });

    it("reports its connection status to the container", async () => {
      const onStatusChange = vi.fn();
      fetchWithAuthMock.mockResolvedValue(makeResponse(CONNECTED));
      render(<M365Integration onStatusChange={onStatusChange} />);
      await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith("connected"));
      expect(onStatusChange).toHaveBeenCalledWith("loading");
    });
  });
});
