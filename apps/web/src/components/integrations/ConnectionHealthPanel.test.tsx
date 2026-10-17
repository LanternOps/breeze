import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ConnectionHealthPanel, { KNOWN_CONDITIONS } from "./ConnectionHealthPanel";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => "https://us.2breeze.app"),
}));

const fetchMock = vi.mocked(fetchWithAuth);

function res(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const now = Date.now();
function incident(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    sourceKind: "psa",
    orgId: null,
    condition: "sync_failed",
    severity: "permanent",
    detail: "Boom <b>bold</b>",
    displayName: "ConnectWise",
    fixHref: "/integrations#psa",
    firstFailedAt: new Date(now - 7200_000).toISOString(),
    openedAt: new Date(now - 3600_000).toISOString(),
    lastObservedAt: new Date(now).toISOString(),
    resolvedAt: null,
    resolution: null,
    ...over,
  };
}

function mockBoth(open: unknown[], recent: unknown[] = [], truncated = false) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("status=open")) return res({ data: open, truncated });
    return res({ data: recent, truncated: false });
  });
}

describe("ConnectionHealthPanel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("renders open rows with a fix link and plain-text detail", async () => {
    mockBoth([incident()]);
    render(<ConnectionHealthPanel />);
    const rows = await screen.findAllByTestId("connection-health-open-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("ConnectWise");
    expect(rows[0].textContent).toContain("Boom <b>bold</b>");
    expect(rows[0].querySelector("b")).toBeNull();
    const link = rows[0].querySelector("a");
    expect(link?.getAttribute("href")).toBe("/integrations#psa");
    expect(fetchMock).toHaveBeenCalledWith("/connection-health/incidents?status=open");
    expect(fetchMock).toHaveBeenCalledWith("/connection-health/incidents?status=recent");
  });

  it("omits the fix link for unsafe hrefs", async () => {
    mockBoth([
      incident({ id: "a", fixHref: "//evil.example" }),
      incident({ id: "b", fixHref: "javascript:alert(1)" }),
    ]);
    render(<ConnectionHealthPanel />);
    const rows = await screen.findAllByTestId("connection-health-open-row");
    for (const r of rows) expect(r.querySelector("a")).toBeNull();
  });

  it("falls back to the unknown condition label", async () => {
    mockBoth([incident({ condition: "brand_new_code" })]);
    render(<ConnectionHealthPanel />);
    const row = await screen.findByTestId("connection-health-open-row");
    expect(row.textContent).not.toContain("connectionHealthPanel.");
    expect(row.textContent).not.toContain("brand_new_code");
  });

  it("shows the healthy empty state", async () => {
    mockBoth([]);
    render(<ConnectionHealthPanel />);
    expect(await screen.findByTestId("connection-health-empty")).toBeTruthy();
    expect(screen.queryByTestId("connection-health-recent-toggle")).toBeNull();
  });

  it.each([401, 403])("renders nothing on %i", async (status) => {
    fetchMock.mockResolvedValue(res({ error: "no" }, status));
    const { container } = render(<ConnectionHealthPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
  });

  it("shows an error with retry that refetches", async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    render(<ConnectionHealthPanel />);
    expect(await screen.findByTestId("connection-health-error")).toBeTruthy();
    mockBoth([incident()]);
    fireEvent.click(screen.getByTestId("connection-health-retry"));
    expect(await screen.findByTestId("connection-health-open-row")).toBeTruthy();
  });

  it("treats a 200 without a data array as an error, never as all healthy", async () => {
    fetchMock.mockResolvedValue(res({ success: false }));
    render(<ConnectionHealthPanel />);
    expect(await screen.findByTestId("connection-health-error")).toBeTruthy();
    expect(screen.queryByTestId("connection-health-empty")).toBeNull();
  });

  it("treats a thrown fetch as an error, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("net"));
    render(<ConnectionHealthPanel />);
    expect(await screen.findByTestId("connection-health-error")).toBeTruthy();
  });

  it("expands recently resolved rows", async () => {
    mockBoth(
      [],
      [
        incident({
          id: "r1",
          displayName: "Huntress",
          resolvedAt: new Date(now - 60_000).toISOString(),
          resolution: "recovered",
        }),
      ],
    );
    render(<ConnectionHealthPanel />);
    const toggle = await screen.findByTestId("connection-health-recent-toggle");
    expect(toggle.textContent).toContain("1");
    expect(screen.queryByTestId("connection-health-recent-row")).toBeNull();
    fireEvent.click(toggle);
    const row = await screen.findByTestId("connection-health-recent-row");
    expect(row.textContent).toContain("Huntress");
  });

  it("shows a truncation note", async () => {
    mockBoth([incident()], [], true);
    render(<ConnectionHealthPanel />);
    await screen.findByTestId("connection-health-open-row");
    expect(screen.getByTestId("connection-health-panel").textContent).toContain("500");
  });

  it("has an en translation for every known condition", () => {
    const en = JSON.parse(
      readFileSync(join(__dirname, "../../locales/en/integrations.json"), "utf8"),
    );
    for (const code of [...KNOWN_CONDITIONS, "unknown"]) {
      expect(typeof en.connectionHealthPanel.condition[code]).toBe("string");
    }
    expect(KNOWN_CONDITIONS).toHaveLength(17);
  });
});
