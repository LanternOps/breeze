import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AiTurnModelBadge from './AiTurnModelBadge';

const base = { requestedModel: 'o', requestedDisplayName: 'Opus 5.5', servedModel: 'o', servedDisplayName: 'Opus 5.5', fallbackUsed: false, appliedOptions: { effort: 'high' as const }, fastDowngraded: false };

describe('AiTurnModelBadge (spike constraint 5: show what ran)', () => {
  it('names the served model and the applied effort', () => {
    render(<AiTurnModelBadge turnModel={base} />);
    expect(screen.getByTestId('ai-turn-model').textContent).toContain('Opus 5.5');
    expect(screen.getByTestId('ai-turn-model').textContent).toContain('High');
  });
  it('a fallback names the served model and says it fell back', () => {
    render(<AiTurnModelBadge turnModel={{ ...base, servedModel: 'x', servedDisplayName: 'Claude Opus 4.8', fallbackUsed: true }} />);
    const el = screen.getByTestId('ai-turn-model');
    expect(el.textContent).toContain('Claude Opus 4.8');
    expect(screen.getByTestId('ai-turn-model-fallback')).toBeInTheDocument();
  });
  it('fast that was downgraded says it ran at standard speed', () => {
    render(<AiTurnModelBadge turnModel={{ ...base, appliedOptions: { speed: 'standard' }, fastDowngraded: true }} />);
    expect(screen.getByTestId('ai-turn-model-fast-downgraded')).toBeInTheDocument();
  });
  it('renders nothing before the first turn', () => {
    const { container } = render(<AiTurnModelBadge turnModel={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
