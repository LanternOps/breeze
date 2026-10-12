import { describe, it, expect, vi } from 'vitest';
import { captureFramePng, screenshotFailureMessage, type CanvasFactory } from './screenshot';

function fakeCanvas(blob: Blob | null = new Blob(['png'], { type: 'image/png' })) {
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((cb: (b: Blob | null) => void, type?: string) => cb(type === 'image/png' ? blob : null)),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, drawImage, raw: canvas };
}

describe('captureFramePng', () => {
  it('draws the current video frame at its intrinsic size, not the on-screen size', async () => {
    const { canvas, drawImage, raw } = fakeCanvas();
    const factory: CanvasFactory = () => canvas;
    const video = { videoWidth: 2560, videoHeight: 1440 } as HTMLVideoElement;
    const blob = await captureFramePng({ kind: 'video', video }, factory);
    expect(blob?.type).toBe('image/png');
    expect(raw.width).toBe(2560);
    expect(raw.height).toBe(1440);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 2560, 1440);
  });

  it('returns null when the video has no frame yet', async () => {
    const factory = vi.fn();
    const blob = await captureFramePng({ kind: 'video', video: { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement }, factory);
    expect(blob).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('encodes the WebSocket canvas directly', async () => {
    const { canvas, raw } = fakeCanvas();
    raw.width = 800;
    raw.height = 600;
    const blob = await captureFramePng({ kind: 'canvas', canvas });
    expect(blob?.type).toBe('image/png');
  });

  it('returns null for an empty canvas', async () => {
    const { canvas } = fakeCanvas();
    expect(await captureFramePng({ kind: 'canvas', canvas })).toBeNull();
  });

  it('asks noVNC for its frame', async () => {
    const capture = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    expect((await captureFramePng({ kind: 'vnc', capture }))?.type).toBe('image/png');
    expect(capture).toHaveBeenCalledOnce();
  });

  it('turns an encoder failure into null rather than throwing', async () => {
    const { canvas, raw } = fakeCanvas();
    raw.width = 10;
    raw.height = 10;
    raw.toBlob = vi.fn(() => { throw new Error('tainted'); });
    expect(await captureFramePng({ kind: 'canvas', canvas })).toBeNull();
  });
});

describe('screenshotFailureMessage', () => {
  it('says what failed without echoing internals', () => {
    expect(screenshotFailureMessage('no-frame')).toMatch(/no picture/i);
    expect(screenshotFailureMessage('copy')).toMatch(/copied/i);
    expect(screenshotFailureMessage('save')).toMatch(/saved/i);
  });
});
