// Shared logo -> data URI encoder. Org/partner branding persists the logo inline
// (settings JSON, 400 KB cap) — there is no upload endpoint — so a picked file
// must be encoded to a data URI, never persisted as a session-local blob: URL.
export const MAX_LOGO_BYTES = 400_000;
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';

// Long-side pixel limits, largest first. Quote and report PDFs print the logo
// ~2.5in wide, so the first try keeps enough pixels to stay sharp in print
// (256px printed soft, ~100dpi). A detailed logo whose data URL would exceed
// MAX_LOGO_BYTES steps down rather than being rejected.
const LOGO_MAX_SIDES = [800, 512, 256];

function encodeLogo(img: HTMLImageElement, maxSide: number): string {
  let { width, height } = img;
  if (width > maxSide || height > maxSide) {
    const ratio = Math.min(maxSide / width, maxSide / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

export function resizeToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        // Never upscale: a limit at or above the native size encodes once at
        // native size, and smaller limits only apply if that is too large.
        const longSide = Math.max(img.width, img.height);
        // A zero-size canvas encodes to the literal "data:,", which would pass
        // the size cap and persist as an unusable logo.
        if (!longSide) throw new Error('Image has no dimensions');
        const sides = [...new Set(LOGO_MAX_SIDES.map((max) => Math.min(max, longSide)))];
        let dataUrl = '';
        for (const side of sides) {
          dataUrl = encodeLogo(img, side);
          if (dataUrl.length <= MAX_LOGO_BYTES) break;
        }
        // Still over the cap at the smallest size: the caller shows the size error.
        resolve(dataUrl);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Invalid image file'));
    };
    img.src = objectUrl;
  });
}
