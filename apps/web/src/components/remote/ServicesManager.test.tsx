import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ServicesManager from './ServicesManager';

describe('ServicesManager headings', () => {
  it('titles the Windows services view "Services"', () => {
    render(<ServicesManager deviceId="d1" deviceName="PC-1" deviceOs="windows" services={[]} />);
    expect(screen.getByRole('heading', { name: 'Services' })).toBeInTheDocument();
  });

  it('titles the non-Windows notice "Windows only"', () => {
    render(<ServicesManager deviceId="d1" deviceName="MAC-1" deviceOs="macos" services={[]} />);
    expect(screen.getByRole('heading', { name: 'Windows only' })).toBeInTheDocument();
  });
});
