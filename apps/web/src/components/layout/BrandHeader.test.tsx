import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BrandHeader from './BrandHeader';

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('BrandHeader', () => {
  it('renders the Breeze SVG fallback when logoUrl is null', () => {
    const { container } = render(<BrandHeader logoUrl={null} name={null} showLabel />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders "Breeze" when name is null and showLabel is true', () => {
    render(<BrandHeader logoUrl={null} name={null} showLabel />);
    expect(screen.getByText('Breeze')).toBeInTheDocument();
  });

  it('renders the partner name when provided and showLabel is true', () => {
    render(<BrandHeader logoUrl={null} name="Acme MSP" showLabel />);
    expect(screen.getByText('Acme MSP')).toBeInTheDocument();
    expect(screen.queryByText('Breeze')).not.toBeInTheDocument();
  });

  it('hides the label when showLabel is false', () => {
    render(<BrandHeader logoUrl={null} name="Acme MSP" showLabel={false} />);
    expect(screen.queryByText('Acme MSP')).not.toBeInTheDocument();
  });

  it('renders an <img> for a valid HTTPS URL', () => {
    render(<BrandHeader logoUrl="https://cdn.example.com/logo.png" name="Acme MSP" showLabel />);
    const img = screen.getByRole('img', { name: /acme msp logo/i }) as HTMLImageElement;
    expect(img.src).toBe('https://cdn.example.com/logo.png');
  });

  it('renders an <img> for a valid PNG data URI', () => {
    render(<BrandHeader logoUrl={PNG_DATA_URI} name="Acme MSP" showLabel />);
    expect(screen.getByRole('img', { name: /acme msp logo/i })).toBeInTheDocument();
  });

  it('falls back to the SVG for an unsafe URL', () => {
    const { container } = render(
      <BrandHeader logoUrl="javascript:alert(1)" name="Acme MSP" showLabel />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the SVG for an SVG data URI', () => {
    const { container } = render(
      <BrandHeader logoUrl="data:image/svg+xml;base64,PHN2Zy8+" name="Acme MSP" showLabel />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
