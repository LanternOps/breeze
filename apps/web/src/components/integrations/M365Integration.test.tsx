import { render, screen, waitFor } from "@testing-library/react";
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
});
