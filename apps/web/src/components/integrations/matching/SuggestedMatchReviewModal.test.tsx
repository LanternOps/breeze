import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SuggestedMatchReviewModal, type MatchReviewItem } from "./SuggestedMatchReviewModal";

const items: MatchReviewItem[] = [
  { key: "a", externalName: "Acme Inc", targetLabel: "Acme", tier: "exact", matchKey: "acme" },
  { key: "b", externalName: "Globex LLC", targetLabel: "Globex", tier: "normalized", matchKey: "globex" },
];

function setup(over: Partial<React.ComponentProps<typeof SuggestedMatchReviewModal>> = {}) {
  const props = {
    open: true,
    items,
    blocked: [{ key: "z", externalName: "Initech", reason: "ambiguous" as const }],
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    testIdPrefix: "t",
    ...over,
  };
  const utils = render(<SuggestedMatchReviewModal {...props} />);
  return { props, ...utils };
}

describe("SuggestedMatchReviewModal", () => {
  it("renders null when closed", () => {
    setup({ open: false });
    expect(screen.queryByTestId("t-review-modal")).toBeNull();
  });

  it("renders items checked by default and blocked rows without a checkbox", () => {
    setup();
    expect((screen.getByTestId("t-review-item-a") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("t-review-item-b") as HTMLInputElement).checked).toBe(true);
    const blocked = screen.getByTestId("t-review-blocked-z");
    expect(blocked.textContent).toContain("Initech");
    expect(blocked.querySelector("input")).toBeNull();
    expect(screen.getByTestId("t-review-confirm").textContent).toContain("2");
  });

  it("unchecking changes the count and confirm sends only checked keys", async () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("t-review-item-a"));
    expect(screen.getByTestId("t-review-confirm").textContent).toContain("1");
    fireEvent.click(screen.getByTestId("t-review-confirm"));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith(["b"]));
  });

  it("disables confirm when nothing is checked", () => {
    setup();
    fireEvent.click(screen.getByTestId("t-review-item-a"));
    fireEvent.click(screen.getByTestId("t-review-item-b"));
    expect((screen.getByTestId("t-review-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables confirm while pending and re-enables after rejection", async () => {
    let reject!: (e: Error) => void;
    const onConfirm = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
    setup({ onConfirm });
    const btn = screen.getByTestId("t-review-confirm") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    reject(new Error("x"));
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("resets selection when items change", () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByTestId("t-review-item-a"));
    rerender(<SuggestedMatchReviewModal {...props} items={[items[0]!, items[1]!]} />);
    expect((screen.getByTestId("t-review-item-a") as HTMLInputElement).checked).toBe(true);
  });

  it("cancel calls onClose", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("t-review-cancel"));
    expect(props.onClose).toHaveBeenCalled();
  });
});
