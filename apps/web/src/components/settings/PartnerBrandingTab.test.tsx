import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PartnerBrandingTab from './PartnerBrandingTab';
import type { InheritableBrandingSettings } from '@breeze/shared';

const defaultData: InheritableBrandingSettings = {};

function makeFile(name = 'logo.png', type = 'image/png', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

// Simulate the canvas API so resizeToDataUrl doesn't reject with "Canvas unavailable".
// Replaces toDataURL with a controlled string; getContext returns a no-op 2d stub.
function mockCanvas(dataUrl: string) {
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...args: any[]) => {
    if (tag === 'canvas') {
      const canvas = origCreate('canvas', ...args) as HTMLCanvasElement;
      canvas.getContext = () => ({ drawImage: vi.fn() } as any);
      canvas.toDataURL = () => dataUrl;
      return canvas;
    }
    return origCreate(tag, ...args);
  });
}

// Stub Image so that setting .src immediately fires onload (or onerror).
function mockImageLoad(mode: 'load' | 'error' = 'load') {
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 100;
    height = 100;
    set src(_: string) {
      if (mode === 'load') setTimeout(() => this.onload?.(), 0);
      else setTimeout(() => this.onerror?.(), 0);
    }
  }
  vi.stubGlobal('Image', MockImage);
}

// Helper: query the URL input by its accessible label.
const getUrlInput = () => screen.getByLabelText(/or paste an image url/i);

beforeEach(() => {
  // Spy on static methods only — replacing the entire URL class would break new URL() in sanitizeImageSrc
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PartnerBrandingTab — URL input', () => {
  it('allows typing intermediate URL values without blocking input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PartnerBrandingTab data={defaultData} onChange={onChange} />);

    const input = getUrlInput();
    // Type an incomplete URL — should not block or trigger onChange yet
    await user.type(input, 'htt');
    expect(input).toHaveValue('htt');
    // onChange is not called until blur with a valid URL
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange with the URL on blur when valid', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PartnerBrandingTab data={defaultData} onChange={onChange} />);

    const input = getUrlInput();
    // Type a URL and blur — blur validation should accept it and call onChange
    await user.type(input, 'https://cdn.example.com/logo.png');
    // Confirm the draft is populated before triggering blur
    expect(input).toHaveValue('https://cdn.example.com/logo.png');
    await user.tab();

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ logoUrl: 'https://cdn.example.com/logo.png' })
    );
  });

  it('shows an error on blur for an unsupported scheme', async () => {
    const user = userEvent.setup();
    render(<PartnerBrandingTab data={defaultData} onChange={vi.fn()} />);

    const input = getUrlInput();
    await user.type(input, 'javascript:alert(1)');
    await user.tab();

    expect(screen.getByText(/url not supported/i)).toBeInTheDocument();
  });

  it('shows an error and does not call onChange for a blob URL', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PartnerBrandingTab data={defaultData} onChange={onChange} />);

    const input = getUrlInput();
    await user.type(input, 'blob:https://app.example.com/abc');
    await user.tab();

    expect(screen.getByText(/blob urls are temporary/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the error when user starts typing again', async () => {
    const user = userEvent.setup();
    render(<PartnerBrandingTab data={defaultData} onChange={vi.fn()} />);

    const input = getUrlInput();
    await user.type(input, 'bad-url');
    await user.tab();
    expect(screen.getByText(/url not supported/i)).toBeInTheDocument();

    await user.click(input);
    await user.type(input, 'x');
    expect(screen.queryByText(/url not supported/i)).not.toBeInTheDocument();
  });
});

describe('PartnerBrandingTab — Remove button', () => {
  it('clears the logo and any stale error when Remove is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PartnerBrandingTab data={{ logoUrl: 'https://cdn.example.com/logo.png' }} onChange={onChange} />);

    const removeBtn = screen.getByRole('button', { name: /remove/i });
    await user.click(removeBtn);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ logoUrl: undefined }));
  });

  it('is not shown when no logo is set', () => {
    render(<PartnerBrandingTab data={defaultData} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });
});

describe('PartnerBrandingTab — URL field visibility', () => {
  it('hides the URL input when a valid data URI is set', () => {
    const validDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    render(<PartnerBrandingTab data={{ logoUrl: validDataUri }} onChange={vi.fn()} />);
    expect(screen.queryByLabelText(/or paste an image url/i)).not.toBeInTheDocument();
  });

  it('shows the URL input when no logo is set', () => {
    render(<PartnerBrandingTab data={defaultData} onChange={vi.fn()} />);
    expect(getUrlInput()).toBeInTheDocument();
  });

  it('shows the URL input and an error when a saved data URI is invalid', () => {
    // A data URI that starts with "data:" but fails sanitization (empty base64 payload)
    render(<PartnerBrandingTab data={{ logoUrl: 'data:image/png;base64,' }} onChange={vi.fn()} />);
    expect(screen.getByText(/saved logo data is invalid/i)).toBeInTheDocument();
    expect(getUrlInput()).toBeInTheDocument();
  });
});

describe('PartnerBrandingTab — file upload', () => {
  it('shows a size error when the canvas output exceeds 400 KB', async () => {
    const oversized = 'data:image/png;base64,' + 'A'.repeat(400_001);
    mockCanvas(oversized);
    mockImageLoad('load');

    const onChange = vi.fn();
    render(<PartnerBrandingTab data={defaultData} onChange={onChange} />);

    const fileInput = document.getElementById('logo-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(screen.getByText(/image too large after encoding/i)).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a read error when the image file is corrupt', async () => {
    mockCanvas('data:image/png;base64,AAAA');
    mockImageLoad('error');

    const onChange = vi.fn();
    render(<PartnerBrandingTab data={defaultData} onChange={onChange} />);

    const fileInput = document.getElementById('logo-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile('bad.png')] } });

    await waitFor(() => {
      expect(screen.getByText(/could not read image/i)).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange with the data URI when a valid image is uploaded', async () => {
    const validDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    mockCanvas(validDataUri);
    mockImageLoad('load');

    const onChange = vi.fn();
    render(<PartnerBrandingTab data={defaultData} onChange={onChange} />);

    const fileInput = document.getElementById('logo-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ logoUrl: validDataUri })
      );
    });
    expect(screen.queryByText(/too large/i)).not.toBeInTheDocument();
  });
});
