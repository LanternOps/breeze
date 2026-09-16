import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));

import PolicyForm from "./PolicyForm";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const jsonRes = (
  payload: unknown,
  ok = true,
  status = ok ? 200 : 404,
): Response =>
  ({
    ok,
    status,
    statusText: ok ? "OK" : "ERROR",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const CATALOG = [
  { id: "cat-1", name: "Zoom", vendor: "Zoom Video" },
  { id: "cat-2", name: "1Password", vendor: "AgileBits" },
];

function fillRequired() {
  fireEvent.change(
    screen.getByPlaceholderText("e.g. Block Unauthorized Software"),
    {
      target: { value: "Required Apps" },
    },
  );
  fireEvent.change(screen.getByPlaceholderText("Name *"), {
    target: { value: "Zoom" },
  });
}

describe("PolicyForm — catalog link + autoInstall arming (#5509)", () => {
  it("renders a catalog-link select for each software rule, defaulting to none", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    const select = screen.getByTestId(
      "software-rule-catalog-0",
    ) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("");
    expect(screen.getByText("Zoom (Zoom Video)")).toBeInTheDocument();
    expect(screen.getByText("1Password (AgileBits)")).toBeInTheDocument();
  });

  it("includes the selected catalogId in the submitted values", async () => {
    const onSubmit = vi.fn();
    render(<PolicyForm catalogItems={CATALOG} onSubmit={onSubmit} />);
    fillRequired();
    fireEvent.change(screen.getByTestId("software-rule-catalog-0"), {
      target: { value: "cat-1" },
    });
    fireEvent.click(screen.getByText("Save Policy"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].software[0].catalogId).toBe("cat-1");
  });

  it("hides the auto-install checkbox unless mode is allowlist and enforce is on", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    expect(
      screen.queryByTestId("policy-auto-install-checkbox"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    expect(
      screen.queryByTestId("policy-auto-install-checkbox"),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "allowlist" },
    });
    expect(
      screen.getByTestId("policy-auto-install-checkbox"),
    ).toBeInTheDocument();
  });

  it("warns when auto-install is armed but a rule has no linked catalog item", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "allowlist" },
    });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    expect(
      screen.queryByTestId("autoinstall-catalog-warning"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    expect(screen.getByTestId("autoinstall-catalog-warning")).toHaveTextContent(
      "1 of 1 rule(s) have no linked catalog item",
    );
    fireEvent.change(screen.getByTestId("software-rule-catalog-0"), {
      target: { value: "cat-1" },
    });
    expect(
      screen.queryByTestId("autoinstall-catalog-warning"),
    ).not.toBeInTheDocument();
  });

  it("keeps the auto-install checkbox hidden on an allowlist policy that is not enforcing", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "allowlist" },
    });
    expect(
      screen.queryByTestId("policy-auto-install-checkbox"),
    ).not.toBeInTheDocument();
  });

  it("counts only the unlinked rules when linkage is partial", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "allowlist" },
    });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    expect(screen.getByTestId("autoinstall-catalog-warning")).toHaveTextContent(
      "2 of 2 rule(s) have no linked catalog item",
    );
    fireEvent.change(screen.getByTestId("software-rule-catalog-0"), {
      target: { value: "cat-1" },
    });
    expect(screen.getByTestId("autoinstall-catalog-warning")).toHaveTextContent(
      "1 of 2 rule(s) have no linked catalog item",
    );
  });
});

describe("PolicyForm — dry-run device count preview (#5509)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function armAutoInstall() {
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "allowlist" },
    });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
  }

  it("shows a 'new policy' message instead of fetching when there is no policyId yet", () => {
    render(<PolicyForm catalogItems={[]} />);
    armAutoInstall();
    expect(screen.getByTestId("autoinstall-dry-run")).toHaveTextContent(
      "This is a new policy",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and renders the eligible device count for an existing policy", async () => {
    fetchMock.mockResolvedValue(jsonRes({ eligibleDeviceCount: 42 }));
    render(<PolicyForm catalogItems={[]} policyId="pol-1" />);
    armAutoInstall();
    await screen.findByText(
      "This will install missing software on approximately 42 device(s).",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/software-policies/pol-1/install-preview",
    );
  });

  it("degrades to an 'unavailable' message when the preview endpoint fails or doesn't exist", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 404));
    render(<PolicyForm catalogItems={[]} policyId="pol-1" />);
    armAutoInstall();
    await vi.waitFor(() =>
      expect(screen.getByTestId("autoinstall-dry-run")).toHaveTextContent(
        "Device-count preview isn't available yet",
      ),
    );
  });
});


describe("PolicyForm — assignment and grace-period guidance (#6026)", () => {
  it("explains a zero-device preview and links to configuration policies", async () => {
    fetchMock.mockResolvedValue(jsonRes({ eligibleDeviceCount: 0 }));
    render(<PolicyForm policyId="pol-1" defaultValues={{ mode: "allowlist", enforceMode: true, autoInstall: true }} />);
    await vi.waitFor(() => expect(screen.getByTestId("autoinstall-dry-run")).toHaveTextContent(
      "0 devices — usually because this policy is not assigned to any device yet",
    ));
    expect(screen.getByTestId("autoinstall-assignment-link")).toHaveAttribute("href", "/configuration-policies");
  });

  it("explains when a changed grace period takes effect", () => {
    render(<PolicyForm defaultValues={{ enforceMode: true }} />);
    expect(screen.getByTestId("policy-grace-period-help")).toHaveTextContent("Applied on the next compliance pass");
  });
});
