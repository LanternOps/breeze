import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GoogleWorkspaceIntegration from "./GoogleWorkspaceIntegration";
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

describe("GoogleWorkspaceIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a calm not-enabled state (no red error, no connect form) when the feature flag is off (404 not enabled)", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(
        { error: "Google Workspace integration is not enabled" },
        false,
        404,
      ),
    );

    render(<GoogleWorkspaceIntegration />);

    // Calm not-enabled empty state is shown.
    await waitFor(() =>
      expect(
        screen.getByTestId("google-workspace-not-enabled"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        /Google Workspace integration is not enabled on this instance/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/GOOGLE_WORKSPACE_ENABLED/)).toBeInTheDocument();

    // The red "Failed to load connection" error is NOT rendered.
    expect(
      screen.queryByText(/Failed to load connection/i),
    ).not.toBeInTheDocument();

    // The connect form (service-account JSON paste) is hidden.
    expect(
      screen.queryByText(/Service-account JSON key/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save & verify/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the red error UI for a genuine (non-404) load failure", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse({ error: "Boom" }, false, 500),
    );

    render(<GoogleWorkspaceIntegration />);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to load connection \(500\): Boom/i),
      ).toBeInTheDocument(),
    );
    // Not swallowed into the calm state.
    expect(
      screen.queryByTestId("google-workspace-not-enabled"),
    ).not.toBeInTheDocument();
    // Connect form still renders for a real error (defect was only the not-enabled case).
    expect(
      screen.getByRole("button", { name: /Save & verify/i }),
    ).toBeInTheDocument();
  });

  it("keeps the red error UI for a network error", async () => {
    fetchWithAuthMock.mockRejectedValue(new Error("Network down"));

    render(<GoogleWorkspaceIntegration />);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to load connection: Network down/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("google-workspace-not-enabled"),
    ).not.toBeInTheDocument();
  });
});
