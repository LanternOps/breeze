import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

// #9647: recharts' ResponsiveContainer renders nothing when height="100%"
// resolves against an indefinite-height parent. Capture the props it receives.
const containerProps: Array<Record<string, unknown>> = [];
vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: (props: Record<string, unknown> & { children?: ReactNode }) => {
      containerProps.push(props);
      return <div data-testid="rc" />;
    }
  };
});

import ChartWidget from './ChartWidget';
import CapacityForecast from './CapacityForecast';

describe('analytics charts keep a non-zero height floor (#9647)', () => {
  it('ChartWidget passes its height as minHeight', () => {
    containerProps.length = 0;
    render(<ChartWidget title="t" type="line" xKey="x" data={[{ x: 'a', v: 1 }]} height={280} />);
    expect(containerProps).toHaveLength(1);
    expect(containerProps[0].minHeight).toBe(280);
  });

  it('CapacityForecast passes a 240px minHeight', () => {
    containerProps.length = 0;
    render(
      <CapacityForecast title="t" currentValue={50} data={[{ timestamp: 'a', value: 1 }] as never} />
    );
    expect(containerProps).toHaveLength(1);
    expect(containerProps[0].minHeight).toBe(240);
  });
});
