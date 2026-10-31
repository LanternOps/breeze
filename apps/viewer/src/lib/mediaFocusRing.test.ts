import { describe, it, expect } from 'vitest';
import { mediaFocusRing, videoHasFrame } from './mediaFocusRing';

const RING = 'ring-1 ring-inset ring-accent-soft/60';

describe('media focus ring (#10424)', () => {
  it('hides the ring on focused media that has no frame yet', () => {
    // An empty <video>/<canvas> lays out at the 300x150 default, so a ring
    // drawn on it is a small blue box in the middle of the black screen.
    expect(mediaFocusRing(RING, false)).toBe('');
  });

  it('shows the ring once the media is rendering', () => {
    expect(mediaFocusRing(RING, true)).toBe(RING);
  });

  it('shows nothing when the media is not focused', () => {
    expect(mediaFocusRing('', true)).toBe('');
  });

  it('treats a video with no decoded dimensions as frameless', () => {
    expect(videoHasFrame({ videoWidth: 0, videoHeight: 0 })).toBe(false);
    expect(videoHasFrame({ videoWidth: 1920, videoHeight: 0 })).toBe(false);
  });

  it('treats a video with decoded dimensions as rendering', () => {
    expect(videoHasFrame({ videoWidth: 1920, videoHeight: 1080 })).toBe(true);
  });
});
