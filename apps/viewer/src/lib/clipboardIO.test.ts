import { describe, it, expect, vi, beforeEach } from 'vitest';

const plugin = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  readImage: vi.fn(),
  writeImage: vi.fn(),
}));
const imageApi = vi.hoisted(() => ({ newImage: vi.fn() }));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => plugin);
vi.mock('@tauri-apps/api/image', () => ({ Image: { new: imageApi.newImage } }));

import { createTauriClipboardIO, type ImageCodec } from './clipboardIO';

function fakeCodec(): ImageCodec & { encodePng: ReturnType<typeof vi.fn>; decodeToRgba: ReturnType<typeof vi.fn> } {
  return {
    encodePng: vi.fn(async () => new Uint8Array([0x89, 0x50])),
    decodeToRgba: vi.fn(async () => ({ rgba: new Uint8Array(16), width: 2, height: 2 })),
  };
}

function fakeImage() {
  return {
    size: vi.fn(async () => ({ width: 3, height: 1 })),
    rgba: vi.fn(async () => new Uint8Array(12)),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  for (const f of Object.values(plugin)) f.mockReset();
  imageApi.newImage.mockReset();
});

describe('createTauriClipboardIO', () => {
  it('reads text, and reports none when the clipboard holds no text', async () => {
    const io = createTauriClipboardIO(fakeCodec());
    plugin.readText.mockResolvedValueOnce('hi');
    expect(await io.readText()).toBe('hi');
    plugin.readText.mockRejectedValueOnce(new Error('not available in the requested format'));
    expect(await io.readText()).toBeNull();
  });

  it('reads the clipboard image as PNG and releases the image resource', async () => {
    const codec = fakeCodec();
    const io = createTauriClipboardIO(codec);
    const img = fakeImage();
    plugin.readImage.mockResolvedValueOnce(img);
    expect(await io.readImagePng()).toEqual(new Uint8Array([0x89, 0x50]));
    expect(codec.encodePng).toHaveBeenCalledWith(new Uint8Array(12), 3, 1);
    expect(img.close).toHaveBeenCalled();
  });

  it('reports no image when the clipboard holds none', async () => {
    const io = createTauriClipboardIO(fakeCodec());
    plugin.readImage.mockRejectedValueOnce(new Error('no image'));
    expect(await io.readImagePng()).toBeNull();
  });

  it('writes an image by decoding it to RGBA for the clipboard plugin', async () => {
    const codec = fakeCodec();
    const io = createTauriClipboardIO(codec);
    const img = fakeImage();
    imageApi.newImage.mockResolvedValueOnce(img);
    plugin.writeImage.mockResolvedValueOnce(undefined);
    const jpeg = new Uint8Array([0xff, 0xd8]);
    await io.writeImage(jpeg, 'jpeg');
    expect(codec.decodeToRgba).toHaveBeenCalledWith(jpeg, 'jpeg');
    expect(imageApi.newImage).toHaveBeenCalledWith(new Uint8Array(16), 2, 2);
    expect(plugin.writeImage).toHaveBeenCalledWith(img);
    expect(img.close).toHaveBeenCalled();
  });

  it('propagates a failed write so the caller does not record a transfer', async () => {
    const io = createTauriClipboardIO(fakeCodec());
    plugin.writeText.mockRejectedValueOnce(new Error('denied'));
    await expect(io.writeText('x')).rejects.toThrow('denied');
  });
});
