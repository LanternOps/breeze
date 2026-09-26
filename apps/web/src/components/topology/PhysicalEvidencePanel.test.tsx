import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PhysicalEvidencePanel from './PhysicalEvidencePanel';
import { ALT, EXCLUSION, fdbDetail, fdbEvidence, fdbRelationship } from './physicalFixtures';
afterEach(cleanup);

it('labels an FDB attachment truthfully without claiming a cable or showing utilization', () => {
  render(<PhysicalEvidencePanel relationship={fdbRelationship()} />);
  expect(screen.getByTestId('topology-relationship-meaning')).toHaveTextContent('Attachment');
  expect(screen.getByTestId('topology-directness')).toHaveTextContent('Direct connection not established');
  expect(screen.getByTestId('topology-port-role')).toHaveTextContent('Learned through this port');
  expect(screen.getByTestId('topology-evidence-method')).toHaveTextContent('Learned MAC address table (FDB)');
  expect(screen.queryByTestId('topology-cable-utilization')).not.toBeInTheDocument();
});

it('shows both endpoint ports from detail and says when a port is not identified', () => {
  const detail = fdbDetail();
  detail.endpoints.target.reportedPort = { namespace: 'if_index', value: '12' };
  render(<PhysicalEvidencePanel relationship={detail.relationship} detail={detail} />);
  expect(screen.getByTestId('topology-source-port')).toHaveTextContent('Core switch · port-24 (Desk drop)');
  expect(screen.getByTestId('topology-target-port')).toHaveTextContent('Desk 12 · Port not identified');
  expect(screen.getByTestId('topology-target-port')).toHaveTextContent('if_index 12');
});

it.each([
  ['shared', 'Shared or upstream port'], ['unresolved', 'Port not identified'], ['identified', 'Identified port'],
] as const)('labels the %s port role', (portRole, text) => {
  const detail = fdbDetail(); detail.physical = { ...detail.physical!, portRole };
  render(<PhysicalEvidencePanel relationship={detail.relationship} detail={detail} />);
  expect(screen.getByTestId('topology-port-role')).toHaveTextContent(text);
});

it('keeps wireless controller and VPN associations distinct', () => {
  const detail = fdbDetail(); detail.physical = { ...detail.physical!, method: 'unifi', association: 'wireless' };
  const { unmount } = render(<PhysicalEvidencePanel relationship={detail.relationship} detail={detail} />);
  expect(screen.getByTestId('topology-association')).toHaveTextContent('Wireless association (reported by controller)');
  unmount();
  detail.physical = { ...detail.physical, association: 'vpn' };
  render(<PhysicalEvidencePanel relationship={detail.relationship} detail={detail} />);
  expect(screen.getByTestId('topology-association')).toHaveTextContent('VPN or tunnel association');
});

it('lists competing FDB alternatives and the hidden state of an excluded connection', () => {
  const detail = fdbDetail();
  detail.relationship = { ...detail.relationship, excluded: true, confidence: 'low' };
  detail.physical = { ...detail.physical!, fdbSelection: 'competing' };
  detail.alternatives = [{ relationshipId: ALT, sourceNodeId: ALT, sourceNodeLabel: 'Closet switch with a very long name that must wrap inside the inspector', targetNodeId: ALT,
    port: { interfaceId: ALT, name: 'ge-0/0/3', alias: null, key: 'if:3', retired: false }, confidence: 'low' }];
  detail.exclusions = [{ id: EXCLUSION, view: 'physical', reason: 'Lab bench', createdAt: '2026-09-26T10:00:00.000Z' }];
  render(<PhysicalEvidencePanel relationship={detail.relationship} detail={detail} />);
  expect(screen.getByTestId('topology-alternatives')).toHaveTextContent('Closet switch with a very long name');
  expect(screen.getByTestId('topology-alternatives')).toHaveTextContent('ge-0/0/3');
  expect(screen.getByTestId('topology-excluded')).toHaveTextContent('Hidden from: Physical');
});

it('shows observation status, stale evidence and expired detail, and pages evidence on request', () => {
  const evidence = fdbEvidence(); evidence.cursor = 'next-page';
  const onLoadMore = vi.fn();
  render(<PhysicalEvidencePanel relationship={{ ...fdbRelationship(), freshness: 'stale' }} detail={fdbDetail()} evidence={evidence} onLoadMoreEvidence={onLoadMore} />);
  expect(screen.getByTestId('topology-freshness')).toHaveTextContent('Stale');
  expect(screen.getByTestId(`topology-observation-${EXCLUSION}`)).toHaveTextContent('Expired');
  fireEvent.click(screen.getByTestId('topology-evidence-more'));
  expect(onLoadMore).toHaveBeenCalledOnce();
  cleanup();
  render(<PhysicalEvidencePanel relationship={fdbRelationship()} evidence={{ ...fdbEvidence(), observations: [], details: { state: 'expired', reason: 'observation_detail_expired' } }} />);
  expect(screen.getByTestId('topology-evidence-details')).toHaveTextContent('Observation detail has expired');
});
