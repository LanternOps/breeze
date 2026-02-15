import { describe, it, expect } from 'vitest';
import { scaleVideoCoords } from './webrtc';

function setVideoSize(video: HTMLVideoElement, w: number, h: number) {
  Object.defineProperty(video, 'videoWidth', { value: w, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: h, configurable: true });
}

describe('scaleVideoCoords', () => {
  it('maps coordinates with top/bottom letterboxing (object-contain)', () => {
    const video = document.createElement('video');
    setVideoSize(video, 1920, 1080);
    video.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 1000,
      right: 1000,
      bottom: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

    expect(scaleVideoCoords(500, 500, video)).toEqual({ x: 960, y: 540 });
    expect(scaleVideoCoords(500, 10, video).y).toBe(0);
  });

  it('maps coordinates with left/right letterboxing (object-contain)', () => {
    const video = document.createElement('video');
    setVideoSize(video, 1920, 1080);
    video.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 2000,
      height: 500,
      right: 2000,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

    expect(scaleVideoCoords(1000, 250, video)).toEqual({ x: 960, y: 540 });
    expect(scaleVideoCoords(0, 250, video).x).toBe(0);
  });
});

