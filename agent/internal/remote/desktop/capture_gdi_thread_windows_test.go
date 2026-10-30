//go:build windows && !cgo

package desktop

import (
	"sync"
	"testing"
)

// Live GDI capture tests. They need an interactive desktop, so they skip
// rather than fail where GDI has nothing to capture (a service session, a
// headless runner). remote/desktop is excluded from the Test Agent (Windows)
// CI job (#2523): run these by hand on a Windows host, ideally once signed in
// and once from a SYSTEM helper at the sign-in screen (#8434):
//
//	CGO_ENABLED=0 go test ./internal/remote/desktop/ -run 'GDICapturer' -v

func captureOrSkip(t *testing.T, c *gdiCapturer) {
	t.Helper()
	img, err := c.Capture()
	if err != nil {
		t.Fatalf("Capture returned an error (GDI failures must be nil frames): %v", err)
	}
	if img == nil {
		t.Skipf("no GDI frame on this host (no capturable desktop?): %v", c.LastCaptureError())
	}
	captureImagePool.Put(img)
}

// The frame is the DIB section's pixels at the even-aligned screen size, with
// no GetDIBits involved.
func TestGDICapturerCapturesFrameAtAlignedScreenSize(t *testing.T) {
	c := &gdiCapturer{}
	defer c.Close()

	img, err := c.Capture()
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if img == nil {
		t.Skipf("no GDI frame on this host: %v", c.LastCaptureError())
	}
	defer captureImagePool.Put(img)

	w, h, err := c.GetScreenBounds()
	if err != nil {
		t.Fatalf("GetScreenBounds: %v", err)
	}
	aw, ah := AlignEven(w, h)
	if img.Rect.Dx() != aw || img.Rect.Dy() != ah {
		t.Fatalf("frame is %dx%d, want %dx%d", img.Rect.Dx(), img.Rect.Dy(), aw, ah)
	}
	for i := 3; i < len(img.Pix); i += 4 * 997 {
		if img.Pix[i] != 255 {
			t.Fatalf("pixel %d alpha = %d, want 255", i/4, img.Pix[i])
		}
	}
}

// Captures from different goroutines all run on the capturer's one thread,
// and the handles are created once, not rebuilt per caller thread (the #5284
// probe/stream hand-over that this replaces).
func TestGDICapturerKeepsHandlesOnOneThread(t *testing.T) {
	c := &gdiCapturer{}
	defer c.Close()
	captureOrSkip(t, c)

	c.mu.Lock()
	owner := c.state.ownerThreadID
	c.mu.Unlock()
	if owner == 0 {
		t.Fatal("handles were not created")
	}

	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 5; i++ {
				img, _ := c.Capture()
				if img != nil {
					captureImagePool.Put(img)
				}
			}
		}()
	}
	wg.Wait()

	c.mu.Lock()
	defer c.mu.Unlock()
	if got := c.state.ownerThreadID; got != owner {
		t.Fatalf("handles moved from thread %d to %d", owner, got)
	}
	var threadID uint32
	if err := c.thread.Do(func() { threadID = currentThreadID() }); err != nil {
		t.Fatal(err)
	}
	if threadID != owner {
		t.Fatalf("handles belong to thread %d, capture thread is %d", owner, threadID)
	}
}

// Close stops the thread and frees the handles; a later Capture starts over.
func TestGDICapturerCloseThenCaptureRestarts(t *testing.T) {
	c := &gdiCapturer{}
	captureOrSkip(t, c)
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	c.mu.Lock()
	stopped := c.thread == nil && c.state == nil
	c.mu.Unlock()
	if !stopped {
		t.Fatal("Close left the capture thread running")
	}
	captureOrSkip(t, c)
	_ = c.Close()
}
