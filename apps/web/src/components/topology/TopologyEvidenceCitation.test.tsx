import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TopologyEvidenceCitation, { citationTargetName } from './TopologyEvidenceCitation';
import { AI, aiGraphFixture } from './topologyAiFixtures';

afterEach(() => cleanup());
const graph = aiGraphFixture();

it('names a target only from the viewer\'s own graph and opens the server-validated inspector target', () => {
  const onSelect = vi.fn();
  render(<TopologyEvidenceCitation index={0} graph={graph} onSelect={onSelect}
    citation={{ id: AI.link, resourceType: 'relationship', resourceId: AI.link, observedAt: '2026-09-16T12:00:00Z', inspectorTarget: { kind: 'relationship', id: AI.link } }} />);
  const link = screen.getByTestId('topology-evidence-citation-0');
  expect(link.tagName).toBe('BUTTON');
  expect(link).toHaveTextContent('Evidence 1');
  expect(link).toHaveTextContent('Connection · Core switch ↔ Reported gateway');
  expect(link).toHaveAccessibleName(/Evidence 1: Connection Core switch ↔ Reported gateway, observed/);
  expect(link).not.toHaveAttribute('href');
  fireEvent.click(link);
  expect(onSelect).toHaveBeenCalledWith({ kind: 'relationship', id: AI.link });
});

it('shows expired detail — not a link — for a target outside the graph or without one', () => {
  render(<>
    <TopologyEvidenceCitation index={0} graph={graph} onSelect={vi.fn()}
      citation={{ id: 'c', resourceType: 'node', resourceId: AI.foreignNode, observedAt: null, inspectorTarget: { kind: 'node', id: AI.foreignNode } }} />
    <TopologyEvidenceCitation index={1} graph={graph} onSelect={vi.fn()}
      citation={{ id: 'change:1', resourceType: 'change', resourceId: AI.foreignNode, observedAt: null, inspectorTarget: null }} />
  </>);
  for (const id of ['topology-evidence-citation-0', 'topology-evidence-citation-1']) {
    expect(screen.getByTestId(id).tagName).toBe('SPAN');
    expect(screen.getByTestId(id)).toHaveTextContent('Detail no longer available');
  }
  expect(document.body.textContent).not.toContain(AI.foreignNode);
});

it('resolves node and relationship names, and nothing for unknown targets', () => {
  expect(citationTargetName(graph, { kind: 'node', id: AI.switch })).toBe('Core switch');
  expect(citationTargetName(graph, { kind: 'relationship', id: AI.link })).toBe('Core switch ↔ Reported gateway');
  expect(citationTargetName(graph, { kind: 'relationship', id: AI.foreignNode })).toBeNull();
  expect(citationTargetName(graph, null)).toBeNull();
});
