import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FleetDesignOutcome } from '@breeze/shared';
import FleetDesignViewer from './FleetDesignViewer';
import { useDesignSelection } from './useDesignSelection';

/** Fleet Designer W04 (#5654) — renders the viewer with a real selection
 *  hook underneath (rather than a hand-rolled stub) so toggling a checkbox
 *  exercises the actual auto-select rules, not a mock of them. */
function Harness({ outcome, unavailable }: { outcome: FleetDesignOutcome; unavailable?: string[] }) {
  const selection = useDesignSelection(new Set());
  return <FleetDesignViewer outcome={outcome} selection={selection} unavailable={unavailable} />;
}

const OUTCOME: FleetDesignOutcome = {
  schemaVersion: 1,
  sections: {
    found: {
      summary: ['12 devices found'],
      findings: [{ title: 'Old OS', deviceCount: 3, evidence: ['evidence'] }],
    },
    functions: [
      {
        functionKey: 'shared_workstation',
        deviceIds: ['d1', 'd2'],
        confidence: 0.9,
        evidence: ['e1'],
        itemRef: 'functions:shared_workstation',
      },
    ],
    monitoring: [
      {
        functionKey: 'shared_workstation',
        watches: [
          {
            watchType: 'service',
            name: 'svc',
            alertOnStop: true,
            autoRestart: false,
            rationale: 'r',
            itemRef: 'monitoring:shared_workstation:watch:0',
          },
        ],
        alertRules: [],
      },
    ],
    retired: [
      { kind: 'watch', policyId: 'p1', policyName: 'Old policy', itemName: 'Old watch', reason: 'unused', itemRef: 'retired:0' },
    ],
    automation: [
      {
        functionKey: 'shared_workstation',
        playbooks: [{ builtInName: 'Reboot on high CPU' }],
        scripts: [
          {
            name: 'Clear temp files',
            purpose: 'Free disk space',
            osTypes: ['windows'],
            language: 'powershell',
            content: 'Remove-Item -Recurse C:\\Temp\\*',
            itemRef: 'automation:shared_workstation:script:0',
          },
        ],
      },
    ],
    legacy: [
      { scriptId: 'legacy-1', scriptName: 'old-cleanup.ps1', intent: 'Cleanup disk', bucket: 'obsolete', notes: 'superseded', itemRef: 'legacy:legacy-1' },
      {
        scriptId: 'legacy-2',
        scriptName: 'backup.sh',
        intent: 'Backup files',
        bucket: 'covered',
        coveredBy: 'New backup policy',
        notes: '',
        itemRef: 'legacy:legacy-2',
      },
    ],
    baseline: { notes: ['baseline note'], numbers: { alertsPer100EndpointsPerMonth: 1, ticketsPerMonth: 2, precursors: [] } },
    unsure: {
      lowConfidenceFunctions: [],
      unreachableDevices: [],
      needsHuman: ['Confirm role for device X'],
      roleCorrections: [
        { deviceId: 'device-1', currentRole: 'server', proposedRole: 'shared_workstation', evidence: [], billingRelevant: true, itemRef: 'roleCorrections:device-1' },
      ],
    },
  },
  thresholds: {
    confidence: 0.6,
    precursors: { diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2 },
  },
  generatedAt: new Date().toISOString(),
  markdown: '',
};

describe('FleetDesignViewer', () => {
  it('renders all eight sections', () => {
    render(<Harness outcome={OUTCOME} />);
    for (const key of ['found', 'functions', 'monitoring', 'retired', 'automation', 'legacy', 'baseline', 'unsure']) {
      expect(screen.getByTestId(`fleet-design-section-${key}`)).toBeTruthy();
    }
  });

  it('shows historical retired items without offering selection', () => {
    render(<Harness outcome={OUTCOME} />);
    const section = screen.getByTestId('fleet-design-section-retired');
    expect(section.textContent).toContain('Old watch');
    expect(section.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('renders an automation script as a selectable row and toggles selection', () => {
    render(<Harness outcome={OUTCOME} />);
    const checkbox = screen.getByTestId('fleet-design-item-automation:shared_workstation:script:0-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('does not auto-select the owning function when an automation script is selected', () => {
    render(<Harness outcome={OUTCOME} />);
    const scriptCheckbox = screen.getByTestId('fleet-design-item-automation:shared_workstation:script:0-checkbox') as HTMLInputElement;
    fireEvent.click(scriptCheckbox);

    const fnCheckbox = screen.getByTestId('fleet-design-item-functions:shared_workstation-checkbox') as HTMLInputElement;
    expect(fnCheckbox.checked).toBe(false);
  });

  it('renders the script content in a details element below the row', () => {
    render(<Harness outcome={OUTCOME} />);
    const details = screen.getByTestId('fleet-design-script-content-automation:shared_workstation:script:0');
    expect(details.tagName.toLowerCase()).toBe('details');
    expect(details.textContent).toContain('Remove-Item');
  });

  it('renders playbooks read-only (built-in name, no checkbox)', () => {
    render(<Harness outcome={OUTCOME} />);
    const automationSection = screen.getByTestId('fleet-design-section-automation');
    expect(automationSection.textContent).toContain('Reboot on high CPU');
  });

  it('renders the legacy table with bucket text, covered-by, an em dash for empty covered-by, and no checkboxes', () => {
    render(<Harness outcome={OUTCOME} />);
    const table = screen.getByTestId('fleet-design-legacy-table');
    expect(table.querySelector('input[type="checkbox"]')).toBeNull();

    const obsoleteRow = screen.getByTestId('fleet-design-legacy-row-legacy-1');
    expect(obsoleteRow.textContent).toContain('old-cleanup.ps1');
    expect(obsoleteRow.textContent).toContain('—');

    const coveredRow = screen.getByTestId('fleet-design-legacy-row-legacy-2');
    expect(coveredRow.textContent).toContain('New backup policy');
  });
});

describe('unavailable evidence', () => {
  it.each([
    ['org', 'Organization'], ['devices', 'Devices'], ['software', 'Software inventory'],
    ['services', 'System services'], ['network', 'Network evidence'], ['posture', 'Security posture'],
    ['health', 'Fleet health'], ['configuration', 'Configuration'], ['automation', 'Automation evidence'],
    ['logs', 'Event logs'], ['counts', 'Activity counts'], ['precursors', 'Early warning indicators'],
    ['approvedDesign', 'Drift since the approved design'], ['drift', 'Drift since the approved design'],
  ])('shows an explicit not-measured panel for %s', (key, title) => {
    render(<Harness outcome={OUTCOME} unavailable={[key]} />);
    const panel = screen.getByTestId(`fleet-design-section-${key}-not-measured`);
    expect(panel).toHaveTextContent(title);
    expect(panel).toHaveTextContent('Not measured');
    expect(screen.getByTestId('fleet-design-section-found')).toHaveTextContent('12 devices found');
  });

  it('does not mark evidence as unmeasured in older summaries', () => {
    render(<Harness outcome={OUTCOME} />);
    expect(screen.queryByTestId('fleet-design-section-drift-not-measured')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fleet-design-section-approvedDesign-not-measured')).not.toBeInTheDocument();
  });
});

describe('monitor-shaped rule proposals (W05c2 Task 15)', () => {
  it('keeps the approval identity of a monitor-shaped rule proposal', () => {
    const outcome = structuredClone(OUTCOME);
    outcome.sections.monitoring[0]!.alertRules = [{
      name: 'CPU monitor', kind: 'cpu', condition: { operator: 'gt', value: 80 },
      severity: 'high', cooldownMinutes: 5, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
      rationale: 'Protect interactive sessions', action: 'none', paging: 'none',
      itemRef: 'monitoring:shared_workstation:rule:0',
    }];
    render(<Harness outcome={outcome} />);
    expect(screen.getByText('CPU monitor')).toBeInTheDocument();
    expect(screen.getByText('Protect interactive sessions')).toBeInTheDocument();
  });
});
