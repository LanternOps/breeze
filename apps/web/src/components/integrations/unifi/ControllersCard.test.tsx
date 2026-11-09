import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import ControllersCard from "./ControllersCard";
import { defaultControllerSiteId, groupSitesByOrg } from "./unifiHelpers";
import type { ControllerDraft, SiteGroup } from "./unifiTypes";

const group = (
  id: string,
  name: string,
  isInternal: boolean,
  siteNames: string[],
): SiteGroup => ({
  id,
  name,
  isInternal,
  sites: siteNames.map((s) => ({ id: `${id}-${s}`, name: s, orgId: id })),
});

function Harness({ groups }: { groups: SiteGroup[] }) {
  const [draft, setDraft] = useState<ControllerDraft>({
    controllerUrl: "",
    collectorDeviceId: "",
    siteId: "",
    apiKey: "",
  });
  return (
    <ControllersCard
      selfHostedCollectors={[]}
      controllerDraft={draft}
      setControllerDraft={setDraft}
      sitesByOrg={groups}
      agents={[]}
      agentsTruncated={false}
      translateDeviceStatus={(s) => s}
      registeringController={false}
      onRegisterController={() => {}}
    />
  );
}

const siteSelect = () =>
  screen.getByTestId("unifi-controller-site") as HTMLSelectElement;

describe("ControllersCard collector agent location", () => {
  it('shows "Collector agent location" with help', () => {
    render(<Harness groups={[group("o1", "Acme", false, ["HQ"])]} />);
    expect(screen.getByTestId("unifi-controller-site-label")).toHaveTextContent(
      "Collector agent location",
    );
    expect(screen.getByTestId("unifi-controller-site-help")).toHaveTextContent(
      /often your own internal organization/,
    );
  });

  it("lists the internal org group first", () => {
    // Built the way the hook builds it, from raw sites + org rows.
    const groups = groupSitesByOrg(
      [
        { id: "s1", name: "HQ", orgId: "o1" },
        { id: "s2", name: "Office", orgId: "o2" },
      ],
      [
        { id: "o1", name: "Acme", type: "customer" },
        { id: "o2", name: "Zeta Internal", type: "internal" },
      ],
      "Organization",
    );
    render(<Harness groups={groups} />);
    const labels = Array.from(siteSelect().querySelectorAll("optgroup")).map(
      (g) => g.label,
    );
    expect(labels).toEqual(["Zeta Internal", "Acme"]);
  });

  it("preselects the single site of the single internal org", () => {
    render(
      <Harness
        groups={[
          group("o2", "Internal", true, ["Office"]),
          group("o1", "Acme", false, ["HQ"]),
        ]}
      />,
    );
    expect(siteSelect().value).toBe("o2-Office");
  });

  it("preselects once the org types arrive after the sites", () => {
    // Sites can land a render before the org rows, so no group is internal yet.
    const { rerender } = render(
      <Harness groups={[group("o2", "Organization", false, ["Office"])]} />,
    );
    expect(siteSelect().value).toBe("");
    rerender(<Harness groups={[group("o2", "Internal", true, ["Office"])]} />);
    expect(siteSelect().value).toBe("o2-Office");
  });

  it("never replaces a site the user already picked", () => {
    const { rerender } = render(
      <Harness
        groups={[
          group("o1", "Acme", false, ["HQ"]),
          group("o2", "Organization", false, ["Office"]),
        ]}
      />,
    );
    fireEvent.change(siteSelect(), { target: { value: "o1-HQ" } });
    rerender(
      <Harness
        groups={[
          group("o2", "Internal", true, ["Office"]),
          group("o1", "Acme", false, ["HQ"]),
        ]}
      />,
    );
    expect(siteSelect().value).toBe("o1-HQ");
  });

  it("preselects nothing with two internal orgs", () => {
    render(
      <Harness
        groups={[
          group("o1", "Int A", true, ["A1"]),
          group("o2", "Int B", true, ["B1"]),
        ]}
      />,
    );
    expect(siteSelect().value).toBe("");
  });
});

describe("defaultControllerSiteId", () => {
  it("is null unless exactly one internal org has exactly one site", () => {
    expect(
      defaultControllerSiteId([group("o1", "I", true, ["a", "b"])]),
    ).toBeNull();
    expect(
      defaultControllerSiteId([group("o1", "A", false, ["a"])]),
    ).toBeNull();
    expect(defaultControllerSiteId([group("o1", "I", true, ["a"])])).toBe(
      "o1-a",
    );
  });
});
