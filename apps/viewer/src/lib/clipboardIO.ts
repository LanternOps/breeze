/**
 * The local clipboard, through the Tauri clipboard-manager plugin.
 *
 * Tauri, not navigator.clipboard: WKWebView/WebView2 reject clipboard writes
 * outside a user gesture, and a remote push arrives from a DataChannel
 * message handler. The plugin goes through the Rust side and needs none.
 *
 * Images cross the plugin as RGBA. The wire format is PNG (or the agent's
 * JPEG), so they are encoded and decoded here, in the webview's canvas — no
 * Rust image features needed. Grants: clipboard-manager:allow-read-image /
 * allow-write-image (src-tauri/capabilities/default.json), core:image:default
 * (via core:default) for Image.new.
 */
import type { ImageFormat, LocalClipboardIO } from './clipboardSync';

export interface ImageCodec {
  encodePng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array>;
  decodeToRgba(bytes: Uint8Array, format: ImageFormat): Promise<{ rgba: Uint8Array; width: number; height: number }>;
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

async function loadBitmap(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const canvasImageCodec: ImageCodec = {
  async encodePng(rgba, width, height) {
    const ctx = canvas2d(width, height);
    const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
    ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => ctx.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encode failed');
    return new Uint8Array(await blob.arrayBuffer());
  },
  async decodeToRgba(bytes, format) {
    const blob = new Blob([bytes as BlobPart], { type: `image/${format}` });
    const bitmap = await loadBitmap(blob);
    const ctx = canvas2d(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { rgba: new Uint8Array(data.data.buffer), width: data.width, height: data.height };
  },
};

export function createTauriClipboardIO(codec: ImageCodec = canvasImageCodec): LocalClipboardIO {
  const plugin = () => import('@tauri-apps/plugin-clipboard-manager');
  return {
    async readText() {
      try {
        return await (await plugin()).readText();
      } catch {
        // The plugin rejects when the clipboard holds no text (an image, say).
        return null;
      }
    },
    async readImagePng() {
      let img: Awaited<ReturnType<Awaited<ReturnType<typeof plugin>>['readImage']>>;
      try {
        img = await (await plugin()).readImage();
      } catch {
        return null; // no image on the clipboard
      }
      try {
        const { width, height } = await img.size();
        return await codec.encodePng(await img.rgba(), width, height);
      } finally {
        await img.close().catch(() => {});
      }
    },
    async writeText(text) {
      await (await plugin()).writeText(text);
    },
    async writeImage(bytes, format) {
      const { rgba, width, height } = await codec.decodeToRgba(bytes, format);
      const { Image: TauriImage } = await import('@tauri-apps/api/image');
      const img = await TauriImage.new(rgba, width, height);
      try {
        await (await plugin()).writeImage(img);
      } finally {
        await img.close().catch(() => {});
      }
    },
  };
}
