// Keyboard-focus ring on the remote-screen media (#10424).
//
// The viewer focuses the <video>/<canvas> as soon as the transport connects,
// often before the first frame. An empty <video> or <canvas> lays out at the
// browser default of 300x150, and Fit mode centers it, so a ring on it showed
// as a small blue box in the middle of the black "connecting" screen. The ring
// only means something once there is a remote screen to type into, so it waits
// for the first frame. Focus itself is unchanged: keys still route as before.

/** The ring classes to apply, or '' while the media has no frame yet. */
export function mediaFocusRing(focusRing: string, hasFrame: boolean): string {
  return hasFrame ? focusRing : '';
}

/** True once the video has decoded dimensions (0x0 before the first frame). */
export function videoHasFrame(video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>): boolean {
  return video.videoWidth > 0 && video.videoHeight > 0;
}
