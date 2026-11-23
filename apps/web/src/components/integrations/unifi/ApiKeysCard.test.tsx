import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApiKeysCard from "./ApiKeysCard";
import type {
  SavedMapping,
  UnifiHostOption,
  UnifiKeySummary,
} from "./unifiTypes";
import { fetchWithAuth } from "../../../stores/auth";

vi.mock("../../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("@/lib/navigation", () => ({ navigateTo: vi.fn() }));
vi.mock("../../../lib/authScope", () => ({
  getJwtClaims: vi.fn(() => ({ scope: "partner" })),
  loginPathWithNext: vi.fn(() => "/login"),
}));

const fetchMock = vi.mocked(fetchWithAuth);
afterEach(() => vi.clearAllMocks());

function res(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: "x",
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const mkKey = (
  over: Partial<UnifiKeySummary> & { id: string },
): UnifiKeySummary => ({
  label: over.id,
  keyLast4: "wxyz",
  isEnabled: true,
  status: "connected",
  lastSyncAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  lastOkAt: null,
  hostsSeen: 1,
  sitesSeen: 2,
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});

const hosts: UnifiHostOption[] = [
  {
    id: "h1",
    name: "Console 1",
    keyIds: ["k1", "k2"],
    sites: [
      { id: "s1", name: "Only K1", keyIds: ["k1"] },
      { id: "s2", name: "Shared", keyIds: ["k1", "k2"] },
      { id: "s3", name: "Only K2", keyIds: ["k2"] },
    ],
  },
];
const mapping = (unifiSiteId: string): SavedMapping => ({
  id: `m-${unifiSiteId}`,
  orgId: "o",
  siteId: "b",
  unifiHostId: "h1",
  unifiSiteId,
  unifiHostName: null,
  unifiSiteName: null,
});

function renderCard(
  over: Partial<React.ComponentProps<typeof ApiKeysCard>> = {},
) {
  const onChanged = vi.fn();
  const utils = render(
    <ApiKeysCard
      keys={[
        mkKey({ id: "k1", label: "Main" }),
        mkKey({ id: "k2", label: "Second", keyLast4: null }),
      ]}
      hosts={hosts}
      mappings={[mapping("s1"), mapping("s2")]}
      hostsComplete
      onChanged={onChanged}
      {...over}
    />,
  );
  return { onChanged, ...utils };
}

const lastCall = () => {
  const c = fetchMock.mock.calls.at(-1)!;
  return {
    url: c[0] as string,
    method: (c[1] as RequestInit).method,
    body: (c[1] as RequestInit).body
      ? JSON.parse((c[1] as RequestInit).body as string)
      : undefined,
  };
};

describe("ApiKeysCard display", () => {
  it("counts unique sites per key and marks the count incomplete on a partial read", () => {
    const { rerender, onChanged } = renderCard();
    expect(screen.getByTestId("unifi-key-unique-count-k1").textContent).toBe(
      "1",
    );
    expect(screen.getByTestId("unifi-key-unique-count-k2").textContent).toBe(
      "1",
    );
    expect(screen.queryByTestId("unifi-key-unique-incomplete-k1")).toBeNull();
    rerender(
      <ApiKeysCard
        keys={[mkKey({ id: "k1", label: "Main" })]}
        hosts={hosts}
        mappings={[]}
        hostsComplete={false}
        onChanged={onChanged}
      />,
    );
    expect(
      screen.getByTestId("unifi-key-unique-incomplete-k1"),
    ).toBeInTheDocument();
  });

  it("masks the key tail and shows bullets alone while it is null", () => {
    renderCard();
    expect(
      within(screen.getByTestId("unifi-key-row-k1")).getByTestId(
        "unifi-key-mask-k1",
      ).textContent,
    ).toBe("••••wxyz");
    expect(screen.getByTestId("unifi-key-mask-k2").textContent).toBe("••••");
  });

  it("a rejected key shows the reauth badge", () => {
    renderCard({
      keys: [
        mkKey({ id: "k1", status: "reauth_required" }),
        mkKey({ id: "k2" }),
      ],
    });
    expect(screen.getByTestId("unifi-key-status-k1")).toHaveAttribute(
      "data-status",
      "reauth_required",
    );
    expect(screen.getByTestId("unifi-key-status-k2")).toHaveAttribute(
      "data-status",
      "connected",
    );
  });
});

describe("ApiKeysCard confirm", () => {
  it("removing a key lists the mapped sites only that key sees", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-remove-k1"));
    const dialog = await screen.findByTestId("unifi-key-confirm-dialog");
    // s1 is unique to k1 and mapped; s2 is mapped but shared; s3 is k2's.
    expect(dialog.textContent).toContain("Only K1");
    expect(dialog.textContent).not.toContain("Shared");
    expect(dialog.textContent).not.toContain("Only K2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disable also confirms first and lists the same sites", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-toggle-k1"));
    const dialog = await screen.findByTestId("unifi-key-confirm-dialog");
    expect(dialog.textContent).toContain("Only K1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ApiKeysCard mutations", () => {
  it("adds a key with POST /unifi/keys and clears the key input", async () => {
    fetchMock.mockResolvedValue(res({ key: {} }, true, 201));
    const { onChanged } = renderCard();
    const keyInput = screen.getByTestId(
      "unifi-key-add-key",
    ) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.change(screen.getByTestId("unifi-key-add-label"), {
      target: { value: "  Third " },
    });
    fireEvent.change(keyInput, { target: { value: "secret-key" } });
    fireEvent.click(screen.getByTestId("unifi-key-add"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: "/unifi/keys",
      method: "POST",
      body: { label: "Third", apiKey: "secret-key" },
    });
    expect(keyInput.value).toBe("");
  });

  it("renames with PATCH {label}", async () => {
    fetchMock.mockResolvedValue(res({ key: {} }));
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-rename-k1"));
    fireEvent.change(screen.getByTestId("unifi-key-rename-input-k1"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByTestId("unifi-key-rename-save-k1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: "/unifi/keys/k1",
      method: "PATCH",
      body: { label: "Renamed" },
    });
  });

  it("replaces with PATCH {apiKey} and clears the input", async () => {
    fetchMock.mockResolvedValue(res({ key: {} }));
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-replace-k1"));
    const input = screen.getByTestId(
      "unifi-key-replace-input-k1",
    ) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByTestId("unifi-key-replace-save-k1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: "/unifi/keys/k1",
      method: "PATCH",
      body: { apiKey: "new-secret" },
    });
    expect(screen.queryByTestId("unifi-key-replace-input-k1")).toBeNull();
  });

  it("disables with PATCH {isEnabled:false} after confirming", async () => {
    fetchMock.mockResolvedValue(res({ key: {} }));
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-toggle-k1"));
    fireEvent.click(await screen.findByTestId("unifi-key-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: "/unifi/keys/k1",
      method: "PATCH",
      body: { isEnabled: false },
    });
  });

  it("enables a disabled key without a confirm", async () => {
    fetchMock.mockResolvedValue(res({ key: {} }));
    const { onChanged } = renderCard({
      keys: [mkKey({ id: "k1", isEnabled: false }), mkKey({ id: "k2" })],
    });
    fireEvent.click(screen.getByTestId("unifi-key-toggle-k1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: "/unifi/keys/k1",
      method: "PATCH",
      body: { isEnabled: true },
    });
  });

  it("tests with POST /unifi/keys/:id/test", async () => {
    fetchMock.mockResolvedValue(
      res({ success: true, hostsFound: 2, sitesFound: 3 }),
    );
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-test-k2"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toMatchObject({
      url: "/unifi/keys/k2/test",
      method: "POST",
    });
  });

  it("removes with DELETE after confirming", async () => {
    fetchMock.mockResolvedValue(res({ success: true }));
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-remove-k2"));
    fireEvent.click(await screen.findByTestId("unifi-key-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastCall()).toMatchObject({
      url: "/unifi/keys/k2",
      method: "DELETE",
    });
  });

  it("does not call onChanged when the API refuses (409 last enabled key)", async () => {
    fetchMock.mockResolvedValue(
      res(
        { success: false, code: "UNIFI_LAST_ENABLED_KEY", message: "last" },
        false,
        409,
      ),
    );
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByTestId("unifi-key-remove-k2"));
    fireEvent.click(await screen.findByTestId("unifi-key-confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("unifi-key-confirm-dialog")).toBeNull(),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});
