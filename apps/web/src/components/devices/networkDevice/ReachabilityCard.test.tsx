import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReachabilityCard } from './ReachabilityCard';
import type { Collection, Reachability } from './types';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const idleProbeState = {
  checking: false,
  pending: false,
  errorCode: null as null | 'NO_AGENT_IN_SITE',
  checkNow: vi.fn(),
};

const full: Reachability = {
  state: 'responding',
  source: 'network_check',
  observedAt: ago(1),
  lastKnown: null,
  detail: {
    networkCheck: { state: 'online', observedAt: ago(1), responseMs: 4.2, monitorId: 'm1' },
    snmp: { state: 'failing', observedAt: ago(40), consecutiveFailures: 3 },
    scan: { state: 'seen', observedAt: ago(1140), source: 'scan' },
    probe: { state: 'ok', observedAt: ago(12), responseMs: 3.0 },
  },
};

const collection: Collection = {
  templateId: 'tpl-1',
  lastPolledAt: ago(40),
  pollingInterval: 300,
  status: 'failing',
  consecutiveFailures: 3,
  oids: [
    { baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast', state: 'collecting', observedAt: ago(40), instances: [], error: null },
    { baseOid: '1.3.6.1.2.1.25.3.5.1.1', name: 'hrPrinterStatus', mode: 'walk', cadence: 'fast', state: 'unsupported', observedAt: ago(40), instances: [], error: 'noSuchObject' },
  ],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof ReachabilityCard>> = {}) {
  return render(
    <ReachabilityCard
      reachability={full}
      collection={collection}
      timezone="UTC"
      bridgeDeviceId="dev-1"
      bridgeDeviceName="HQ-AGENT-01"
      probeState={idleProbeState}
      onViewMonitoring={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ReachabilityCard', () => {
  it('leads with the sourced headline, never a bare state word', () => {
    renderCard();
    const headline = screen.getByTestId('network-detail-reach-headline');
    expect(headline.textContent).toContain('Responding');
    expect(headline.textContent).toContain('Network check');
    expect(headline.textContent).toContain('·');
    expect(headline).toHaveAttribute('title', expect.stringContaining('20'));
  });

  it('renders one line per contributing source, each with its own age', () => {
    renderCard();
    const card = screen.getByTestId('network-detail-reachability-card');
    expect(card.textContent).toContain('Network check');
    expect(card.textContent).toContain('SNMP');
    expect(card.textContent).toContain('Scan');
    expect(card.textContent).toContain('Probe');
    expect(screen.getByTestId('network-detail-reach-network_check').textContent).toMatch(/1\s*min/);
    expect(screen.getByTestId('network-detail-reach-probe').textContent).toMatch(/12\s*min/);
    expect(screen.getByTestId('network-detail-reach-scan').textContent).toMatch(/19\s*hr/);
    expect(screen.queryByTestId('network-detail-reach-empty')).toBeNull();
  });

  it('pairs a network-check line with its measured response time', () => {
    renderCard();
    expect(screen.getByTestId('network-detail-reach-network_check').textContent).toContain('4.2 ms');
  });

  it('says an SNMP failure is protocol-level, not a device verdict', () => {
    renderCard();
    const snmp = screen.getByTestId('network-detail-reach-snmp');
    expect(snmp.textContent).toContain('Failing');
    expect(snmp.textContent).toContain('3');
    expect(screen.getByTestId('network-detail-reach-snmp-note').textContent).toContain('bridging agent');
  });

  it('summarises collection and links through to the OID table', async () => {
    const onViewMonitoring = vi.fn();
    renderCard({ onViewMonitoring });
    const summary = screen.getByTestId('network-detail-collection-summary');
    expect(summary.textContent).toContain('1 collecting');
    expect(summary.textContent).toContain('1 unsupported');
    await userEvent.click(screen.getByTestId('network-detail-view-oids'));
    expect(onViewMonitoring).toHaveBeenCalledTimes(1);
  });

  it('names the agent that bridges the polls and links to it', () => {
    renderCard();
    const bridge = screen.getByTestId('network-detail-bridge-agent');
    expect(bridge.textContent).toContain('HQ-AGENT-01');
    expect(bridge.querySelector('a')).toHaveAttribute('href', '/devices/dev-1');
  });

  it('renders a dash, not an id, while the device list is still resolving', () => {
    renderCard({ bridgeDeviceId: 'dev-1', bridgeDeviceName: null });
    const bridge = screen.getByTestId('network-detail-bridge-agent');
    expect(bridge.querySelector('a')).toBeNull();
    expect(bridge.textContent).toContain('—');
    expect(bridge.textContent).not.toContain('dev-1');
  });

  it('runs the probe from the card and shows the in-flight line', async () => {
    const checkNow = vi.fn().mockResolvedValue(undefined);
    const view = renderCard({ probeState: { checking: false, pending: false, errorCode: null, checkNow } });
    await userEvent.click(screen.getByTestId('network-detail-card-check-now'));
    expect(checkNow).toHaveBeenCalledTimes(1);
    view.unmount();
    renderCard({ probeState: { checking: true, pending: false, errorCode: null, checkNow } });
    expect(screen.getByTestId('network-detail-card-check-now')).toBeDisabled();
    expect(screen.getByTestId('network-detail-card-probe-status').textContent).toContain('Checking');
  });

  it('renders a probe failure inline on the card', () => {
    renderCard({ probeState: { checking: false, pending: false, errorCode: 'NO_AGENT_IN_SITE', checkNow: vi.fn() } });
    const line = screen.getByTestId('network-detail-card-probe-error');
    expect(line).toHaveAttribute('role', 'status');
    expect(line.textContent).toContain('No online agent');
  });

  it('degrades to a single Unverified line with no detail at all', () => {
    renderCard({
      reachability: { state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} },
      collection: null,
      bridgeDeviceId: null,
      bridgeDeviceName: null,
    });
    expect(screen.getByTestId('network-detail-reach-headline').textContent).toContain('Unverified');
    expect(screen.getByTestId('network-detail-reach-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-collection-summary')).toBeNull();
  });
});
