import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PolicyForm from "./PolicyForm";

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
});
