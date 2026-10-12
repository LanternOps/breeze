// Screenshot (#8241): the current remote frame as a PNG, copied to the local
// clipboard or saved to a local folder. Local only: nothing is uploaded and no
// API is called. Copy goes through the clipboard IO the clipboard sync already
// uses; save goes through the `save_screenshot` Tauri command, which picks the
// folder and file name itself.

export type FrameSource =
  | { kind: 'video'; video: HTMLVideoElement }
  | { kind: 'canvas'; canvas: HTMLCanvasElement }
  | { kind: 'vnc'; capture: () => Promise<Blob | null> };

export type CanvasFactory = () => HTMLCanvasElement;

const defaultCanvasFactory: CanvasFactory = () => document.createElement('canvas');

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** The frame on screen right now, as PNG; null when there is no frame to take. */
export async function captureFramePng(
  source: FrameSource,
  createCanvas: CanvasFactory = defaultCanvasFactory,
): Promise<Blob | null> {
  try {
    switch (source.kind) {
      case 'vnc':
        return await source.capture();
      case 'canvas':
        if (!source.canvas.width || !source.canvas.height) return null;
        return await canvasToPng(source.canvas);
      case 'video': {
        // Intrinsic size: the remote screen's pixels, whatever the window shows.
        const { videoWidth: w, videoHeight: h } = source.video;
        if (!w || !h) return null;
        const canvas = createCanvas();
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(source.video, 0, 0, w, h);
        return await canvasToPng(canvas);
      }
    }
  } catch {
    return null;
  }
}

export type ScreenshotFailure = 'no-frame' | 'copy' | 'save';

export function screenshotFailureMessage(failure: ScreenshotFailure): string {
  switch (failure) {
    case 'no-frame':
      return 'Screenshot failed — there is no picture from the remote yet.';
    case 'copy':
      return 'Screenshot could not be copied to the clipboard.';
    case 'save':
      return 'Screenshot could not be saved.';
  }
}
