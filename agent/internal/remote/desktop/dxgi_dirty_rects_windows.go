//go:build windows

package desktop

import (
	"image"
	"syscall"
	"unsafe"
)

// getDirtyRects calls IDXGIOutputDuplication::GetFrameDirtyRects to retrieve
// the list of screen regions that changed since the last AcquireNextFrame.
// Returns nil if the call fails or no metadata is available (non-fatal).
func getDirtyRects(duplication uintptr, metadataSize uint32) []image.Rectangle {
	if duplication == 0 || metadataSize == 0 {
		return nil
	}

	// Allocate buffer for dirty rects (each RECT is 16 bytes)
	buf := make([]byte, metadataSize)
	var bytesReturned uint32

	hr, _, _ := syscall.SyscallN(
		comVtblFn(duplication, dxgiDuplGetFrameDirtyRects),
		duplication,
		uintptr(len(buf)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if int32(hr) < 0 {
		return nil
	}

	rectSize := uint32(unsafe.Sizeof(dxgiRECT{}))
	count := bytesReturned / rectSize
	if count == 0 {
		return nil
	}

	rects := make([]image.Rectangle, 0, count)
	for i := uint32(0); i < count; i++ {
		r := (*dxgiRECT)(unsafe.Pointer(&buf[i*rectSize]))
		rects = append(rects, image.Rect(
			int(r.Left), int(r.Top),
			int(r.Right), int(r.Bottom),
		))
	}
	return rects
}

// mergeDirtyRects combines dirty rects into a single bounding box.
func mergeDirtyRects(rects []image.Rectangle) image.Rectangle {
	if len(rects) == 0 {
		return image.Rectangle{}
	}
	bounds := rects[0]
	for _, r := range rects[1:] {
		bounds = bounds.Union(r)
	}
	return bounds
}

// dirtyRectCoversFraction returns the fraction of the screen covered by
// the dirty region (0.0 to 1.0).
func dirtyRectCoversFraction(dirty image.Rectangle, screenW, screenH int) float64 {
	if screenW <= 0 || screenH <= 0 {
		return 1.0
	}
	area := dirty.Dx() * dirty.Dy()
	return float64(area) / float64(screenW*screenH)
}
