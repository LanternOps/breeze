//go:build windows && !cgo

package desktop

import (
	"fmt"
	"image"
	"log/slog"
	"syscall"
	"time"
	"unsafe"
)

// sampleCursorForCrossThread reads cursor state on the capture thread (which
// has the correct desktop via SetThreadDesktop) and stores it atomically for
// the cursor stream goroutine to read. Without this, the cursor goroutine's
// GetCursorInfo fails on a different-desktop thread.
func (c *dxgiCapturer) sampleCursorForCrossThread() {
	var ci cursorInfoW
	ci.CbSize = uint32(unsafe.Sizeof(ci))
	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret != 0 {
		c.cursorX.Store(ci.PtScreenPos.X)
		c.cursorY.Store(ci.PtScreenPos.Y)
		c.cursorVis.Store(ci.Flags&cursorShowing != 0)
	}
}

// captureFromGDIFallbackLocked captures from the secure-desktop GDI fallback
// and performs periodic self-healing when BitBlt/DC state is transiently
// unavailable. Caller must hold c.mu.
func (c *dxgiCapturer) captureFromGDIFallbackLocked() (*image.RGBA, error) {
	if c.gdiFallback == nil {
		return nil, nil
	}

	img, err := c.gdiFallback.Capture()
	if err != nil {
		return nil, err
	}
	if img != nil {
		c.gdiNoFrameCount = 0
		return img, nil
	}

	c.gdiNoFrameCount++
	now := time.Now()
	if c.gdiNoFrameCount == 1 || c.gdiNoFrameCount%120 == 0 {
		slog.Warn("GDI fallback produced no frame",
			"count", c.gdiNoFrameCount,
			"secureDesktop", c.secureDesktopFlag.Load())
	}

	// Reattach/recreate fallback periodically if secure desktop capture yields
	// no frame for an extended stretch.
	if c.gdiNoFrameCount >= 15 && now.Sub(c.lastGDIRepair) >= 500*time.Millisecond {
		c.lastGDIRepair = now
		_ = c.switchToInputDesktop()
		if c.gdiFallback != nil {
			_ = c.gdiFallback.Close()
		}
		c.gdiFallback = &gdiCapturer{config: c.config}
		slog.Info("Recreated GDI fallback after repeated no-frame samples",
			"count", c.gdiNoFrameCount)
	}

	return nil, nil
}

// Capture acquires the next desktop frame via DXGI.
// Returns nil, nil when no new frame is available (AccumulatedFrames==0).
func (c *dxgiCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Sample cursor from capture thread (correct desktop context)
	c.sampleCursorForCrossThread()

	// Proactive desktop switch detection: MUST run before GDI fallback check
	// so we can detect when the Secure Desktop is dismissed and switch back
	// to DXGI. Without this, GDI fallback is permanent and never recovers.
	c.checkDesktopSwitch()

	// If we've fallen back to GDI, delegate
	if c.gdiFallback != nil {
		return c.captureFromGDIFallbackLocked()
	}

	if !c.inited {
		return nil, fmt.Errorf("DXGI capturer not initialized")
	}

	var frameInfo dxgiOutDuplFrameInfo
	var resource uintptr

	// 50ms timeout balances idle CPU polling (~20/sec) with frame release latency.
	// AcquireNextFrame returns immediately when a new frame is available
	// (regardless of timeout), so this doesn't add latency for active content.
	hr, _, _ := syscall.SyscallN(
		comVtblFn(c.duplication, dxgiDuplAcquireNextFrame),
		c.duplication,
		uintptr(50),
		uintptr(unsafe.Pointer(&frameInfo)),
		uintptr(unsafe.Pointer(&resource)),
	)

	hresult := uint32(hr)

	if hresult == dxgiErrWaitTimeout {
		c.lastAccumulatedFrames = 0
		c.diagTimeouts++
		if c.diagLogInterval == 0 {
			c.diagLogInterval = 100
		}
		if c.diagTimeouts == 1 || c.diagTimeouts%c.diagLogInterval == 0 {
			slog.Info("DXGI Capture diagnostic",
				"display", c.config.DisplayIndex,
				"timeouts", c.diagTimeouts,
				"zeroFrames", c.diagZeroFrames,
				"success", c.diagSuccessFrames,
			)
		}
		return nil, nil // No new frame
	}

	if hresult == dxgiErrAccessLost || hresult == dxgiErrInvalidCall {
		slog.Info("DXGI duplication invalidated, reinitializing",
			"hresult", fmt.Sprintf("0x%08X", hresult))
		c.releaseDXGI()
		c.switchToInputDesktop()
		time.Sleep(100 * time.Millisecond) // pause for desktop transition to complete

		// Check if we landed on a Secure Desktop (Winlogon/UAC).
		threadID, _, _ := procGetCurrentThreadId.Call()
		desk, _, _ := procGetThreadDesktop.Call(threadID)
		dname := desktopName(desk)
		if dname != "" && dname != "Default" {
			c.desktopSwitchFlag.Store(true)
			c.secureDesktopFlag.Store(true)
			// Use GDI on Secure Desktops — DXGI captures partial/filtered content
			// for UAC dialogs (shows blank white rectangles). GDI BitBlt captures
			// the full composed output including dialog content.
			slog.Info("On Secure Desktop after DXGI error, using GDI capture",
				"desktop", dname)
			c.gdiFallback = &gdiCapturer{config: c.config}
			c.gdiNoFrameCount = 0
			return c.captureFromGDIFallbackLocked()
		}

		// Back on Default desktop
		c.desktopSwitchFlag.Store(true)
		c.secureDesktopFlag.Store(false)
		if err := c.initDXGI(); err != nil {
			slog.Warn("DXGI reinit failed, falling back to GDI", "error", err)
			c.switchToGDI()
			return c.captureFromGDIFallbackLocked()
		}
		return nil, nil
	}

	if hresult == dxgiErrDeviceRemoved || hresult == dxgiErrDeviceReset {
		c.consecutiveFailures++
		slog.Warn("DXGI device error", "hresult", fmt.Sprintf("0x%08X", hresult),
			"failures", c.consecutiveFailures)
		c.releaseDXGI()
		if c.consecutiveFailures >= 3 {
			slog.Warn("Too many DXGI failures, falling back to GDI permanently")
			c.switchToGDI()
			return c.captureFromGDIFallbackLocked()
		}
		c.switchToInputDesktop()
		time.Sleep(500 * time.Millisecond)
		if err := c.initDXGI(); err != nil {
			c.switchToGDI()
			return c.captureFromGDIFallbackLocked()
		}
		return nil, nil
	}

	if int32(hr) < 0 {
		return nil, fmt.Errorf("AcquireNextFrame: 0x%08X", hresult)
	}

	// Success — reset failure counter
	c.consecutiveFailures = 0
	c.lastAccumulatedFrames = frameInfo.AccumulatedFrames

	// No new frames accumulated — skip
	if frameInfo.AccumulatedFrames == 0 {
		c.diagZeroFrames++
		comRelease(resource)
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, nil
	}

	c.diagSuccessFrames++
	// QueryInterface → ID3D11Texture2D
	var texture uintptr
	_, err := comCall(resource, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidID3D11Texture2D)),
		uintptr(unsafe.Pointer(&texture)),
	)
	comRelease(resource)
	if err != nil {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, fmt.Errorf("QueryInterface ID3D11Texture2D: %w", err)
	}

	// CopyResource(staging, texture) — GPU-to-GPU copy.
	// CopyResource is void — no HRESULT return. Errors surface via
	// GetDeviceRemovedReason or a failed Map on the destination texture.
	syscall.SyscallN(
		comVtblFn(c.context, d3d11CtxCopyResource),
		c.context,
		c.staging,
		texture,
	)
	comRelease(texture)

	// Map staging texture
	var mapped d3d11MappedSubresource
	hr, _, _ = syscall.SyscallN(
		comVtblFn(c.context, d3d11CtxMap),
		c.context,
		c.staging,
		0, // Subresource
		1, // D3D11_MAP_READ
		0, // Flags
		uintptr(unsafe.Pointer(&mapped)),
	)
	if int32(hr) < 0 {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, fmt.Errorf("Map staging texture: 0x%08X", uint32(hr))
	}

	// Read BGRA pixels from the mapped staging texture.
	// Staging uses native (pre-rotation) dimensions; output uses logical desktop dims.
	rowPitch := int(mapped.RowPitch)
	img := captureImagePool.Get(c.width, c.height)

	if c.rotation == 2 || c.rotation == 4 {
		// Rotated display: read native-dimension pixels with rotation transform.
		c.readRotated(mapped.PData, rowPitch, img)
	} else {
		// Identity: direct copy (texWidth == width when no rotation).
		rowBytes := c.width * 4
		if rowPitch == rowBytes {
			src := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData)), c.height*rowPitch)
			copy(img.Pix, src)
		} else {
			for y := 0; y < c.height; y++ {
				srcRow := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData+uintptr(y*rowPitch))), rowBytes)
				copy(img.Pix[y*rowBytes:], srcRow)
			}
		}
	}

	// Unmap + ReleaseFrame
	syscall.SyscallN(comVtblFn(c.context, d3d11CtxUnmap), c.context, c.staging, 0)
	syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)

	return img, nil
}

// readRotated reads pixels from mapped GPU memory (native orientation) and writes
// them to img with rotation applied, producing the correct desktop orientation.
// pData is the mapped staging texture pointer, rowPitch is the GPU row stride.
func (c *dxgiCapturer) readRotated(pData uintptr, rowPitch int, img *image.RGBA) {
	srcW := c.texWidth  // native texture width
	srcH := c.texHeight // native texture height
	dstW := c.width     // output (desktop) width

	if c.rotation == 2 {
		// ROTATE90: undo by rotating 90° CW.
		// desktop(ox, oy) = native(oy, srcH - 1 - ox)
		for oy := 0; oy < c.height; oy++ {
			sx := oy // constant for this row
			for ox := 0; ox < c.width; ox++ {
				sy := srcH - 1 - ox
				srcOff := uintptr(sy*rowPitch + sx*4)
				dstOff := (oy*dstW + ox) * 4
				*(*[4]byte)(unsafe.Pointer(&img.Pix[dstOff])) = *(*[4]byte)(unsafe.Pointer(pData + srcOff))
			}
		}
	} else {
		// ROTATE270: undo by rotating 90° CCW.
		// desktop(ox, oy) = native(srcW - 1 - oy, ox)
		for oy := 0; oy < c.height; oy++ {
			sx := srcW - 1 - oy // constant for this row
			for ox := 0; ox < c.width; ox++ {
				sy := ox
				srcOff := uintptr(sy*rowPitch + sx*4)
				dstOff := (oy*dstW + ox) * 4
				*(*[4]byte)(unsafe.Pointer(&img.Pix[dstOff])) = *(*[4]byte)(unsafe.Pointer(pData + srcOff))
			}
		}
	}
}

// CaptureRegion captures a specific region via full capture + crop.
func (c *dxgiCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}
	if fullImg == nil {
		return nil, nil
	}

	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		captureImagePool.Put(fullImg)
		return nil, fmt.Errorf("region out of bounds")
	}

	cropped := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		srcStart := (y+dy)*fullImg.Stride + x*4
		dstStart := dy * cropped.Stride
		copy(cropped.Pix[dstStart:dstStart+width*4], fullImg.Pix[srcStart:srcStart+width*4])
	}

	captureImagePool.Put(fullImg)
	return cropped, nil
}

// GetScreenBounds returns the screen dimensions.
func (c *dxgiCapturer) GetScreenBounds() (width, height int, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.gdiFallback != nil {
		return c.gdiFallback.GetScreenBounds()
	}

	if c.inited && c.width > 0 && c.height > 0 {
		return c.width, c.height, nil
	}

	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return 0, 0, fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	return int(w), int(h), nil
}

// TightLoop implements TightLoopHint.
func (c *dxgiCapturer) TightLoop() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gdiFallback == nil && c.inited
}

// IsBGRA implements BGRAProvider.
//
// When DXGI is active, Capture() returns BGRA bytes stored in image.RGBA.Pix.
// When operating in GDI fallback mode, the underlying gdiCapturer returns true RGBA.
func (c *dxgiCapturer) IsBGRA() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gdiFallback == nil && c.inited
}

// AccumulatedFrames implements FrameChangeHint.
func (c *dxgiCapturer) AccumulatedFrames() uint32 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastAccumulatedFrames
}

// CaptureTexture acquires a frame and copies it to the GPU texture
// (DEFAULT usage, RENDER_TARGET bind), returning the handle without
// mapping to CPU memory. Returns 0, nil when no new frame is available.
func (c *dxgiCapturer) CaptureTexture() (uintptr, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.sampleCursorForCrossThread()

	// Proactive desktop switch detection: MUST run before gdiFallback check
	// so we can switch back to DXGI when the Secure Desktop is dismissed.
	c.checkDesktopSwitch()

	if c.gdiFallback != nil || !c.inited {
		return 0, nil
	}
	// GPU path doesn't support display rotation yet — return error so caller
	// permanently disables GPU and falls back to CPU Capture() path.
	if c.rotation == 2 || c.rotation == 4 {
		return 0, fmt.Errorf("GPU path unsupported for rotated display (rotation=%d)", c.rotation)
	}
	if c.textureFrameAcquired {
		// This indicates caller misuse: they didn't call ReleaseTexture().
		// Protect against re-entrancy and overwriting the shared gpuTexture.
		return 0, fmt.Errorf("previous DXGI frame not released")
	}

	// GPU texture is required for the video processor pipeline
	if c.gpuTexture == 0 {
		return 0, fmt.Errorf("GPU texture not available (display=%d)", c.config.DisplayIndex)
	}

	var frameInfo dxgiOutDuplFrameInfo
	var resource uintptr

	hr, _, _ := syscall.SyscallN(
		comVtblFn(c.duplication, dxgiDuplAcquireNextFrame),
		c.duplication,
		uintptr(50),
		uintptr(unsafe.Pointer(&frameInfo)),
		uintptr(unsafe.Pointer(&resource)),
	)

	hresult := uint32(hr)
	if hresult == dxgiErrWaitTimeout {
		c.lastAccumulatedFrames = 0
		c.diagTimeouts++
		if c.diagTimeouts == 1 || c.diagTimeouts%200 == 0 {
			slog.Debug("DXGI CaptureTexture diagnostic",
				"display", c.config.DisplayIndex,
				"timeouts", c.diagTimeouts,
				"zeroFrames", c.diagZeroFrames,
				"success", c.diagSuccessFrames,
			)
		}
		return 0, nil
	}
	if hresult == dxgiErrAccessLost || hresult == dxgiErrInvalidCall {
		slog.Info("DXGI duplication invalidated during GPU capture, reinitializing",
			"hresult", fmt.Sprintf("0x%08X", hresult))
		c.releaseDXGI()
		c.switchToInputDesktop()
		time.Sleep(100 * time.Millisecond)

		threadID, _, _ := procGetCurrentThreadId.Call()
		desk, _, _ := procGetThreadDesktop.Call(threadID)
		dname := desktopName(desk)
		if dname != "" && dname != "Default" {
			c.desktopSwitchFlag.Store(true)
			c.secureDesktopFlag.Store(true)
			slog.Info("On Secure Desktop after DXGI error (GPU), using GDI capture",
				"desktop", dname)
			c.gdiFallback = &gdiCapturer{config: c.config}
			return 0, nil // Caller falls through to CPU Capture() path
		}

		c.desktopSwitchFlag.Store(true)
		c.secureDesktopFlag.Store(false)
		if err := c.initDXGI(); err != nil {
			slog.Warn("DXGI reinit failed after access lost (GPU capture), falling back to GDI", "error", err)
			c.switchToGDI()
		}
		return 0, nil
	}
	if hresult == dxgiErrDeviceRemoved || hresult == dxgiErrDeviceReset {
		c.consecutiveFailures++
		slog.Warn("DXGI device error during GPU capture", "hresult", fmt.Sprintf("0x%08X", hresult),
			"failures", c.consecutiveFailures)
		c.releaseDXGI()
		if c.consecutiveFailures >= 3 {
			slog.Warn("Too many DXGI failures (GPU capture), falling back to GDI permanently")
			c.switchToGDI()
			return 0, nil
		}
		c.switchToInputDesktop()
		time.Sleep(500 * time.Millisecond)
		if err := c.initDXGI(); err != nil {
			c.switchToGDI()
			return 0, nil
		}
		return 0, nil
	}
	if int32(hr) < 0 {
		return 0, fmt.Errorf("AcquireNextFrame: 0x%08X", hresult)
	}

	c.consecutiveFailures = 0
	c.lastAccumulatedFrames = frameInfo.AccumulatedFrames

	if frameInfo.AccumulatedFrames == 0 {
		c.diagZeroFrames++
		comRelease(resource)
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return 0, nil
	}

	c.diagSuccessFrames++
	if c.diagSuccessFrames <= 3 {
		slog.Debug("DXGI CaptureTexture frame acquired",
			"display", c.config.DisplayIndex,
			"accumulated", frameInfo.AccumulatedFrames,
			"frameNum", c.diagSuccessFrames,
		)
	}

	// QueryInterface → ID3D11Texture2D
	var texture uintptr
	_, err := comCall(resource, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidID3D11Texture2D)),
		uintptr(unsafe.Pointer(&texture)),
	)
	comRelease(resource)
	if err != nil {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return 0, fmt.Errorf("QueryInterface ID3D11Texture2D: %w", err)
	}

	// Diagnostic: check actual acquired texture dimensions vs our staging/gpu texture.
	if c.diagSuccessFrames <= 3 {
		var texDesc d3d11Texture2DDesc
		syscall.SyscallN(comVtblFn(texture, 10), // ID3D11Texture2D::GetDesc = vtable[10]
			texture, uintptr(unsafe.Pointer(&texDesc)))
		slog.Debug("DXGI acquired texture dimensions",
			"display", c.config.DisplayIndex,
			"texW", texDesc.Width, "texH", texDesc.Height,
			"nativeW", c.texWidth, "nativeH", c.texHeight,
			"rotation", c.rotation,
			"format", texDesc.Format,
		)
	}

	// CopyResource(gpuTexture, texture) — GPU-to-GPU copy into DEFAULT-usage texture.
	// CopyResource is void — no HRESULT return. Errors surface via
	// GetDeviceRemovedReason or a failed encode step.
	syscall.SyscallN(
		comVtblFn(c.context, d3d11CtxCopyResource),
		c.context,
		c.gpuTexture,
		texture,
	)

	// Flush ensures CopyResource reaches the GPU before downstream reads
	// (e.g., VideoProcessorBlt in the encoder pipeline).
	syscall.SyscallN(comVtblFn(c.context, d3d11CtxFlush), c.context)

	comRelease(texture)

	// Return GPU texture handle — caller must call ReleaseTexture()
	c.textureFrameAcquired = true
	return c.gpuTexture, nil
}

// ReleaseTexture releases the DXGI frame acquired by CaptureTexture.
func (c *dxgiCapturer) ReleaseTexture() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.textureFrameAcquired {
		return
	}
	if c.duplication != 0 {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
	}
	c.textureFrameAcquired = false
}

// GetD3D11Device returns the D3D11 device handle.
func (c *dxgiCapturer) GetD3D11Device() uintptr {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.device
}

// GetD3D11Context returns the immediate device context handle.
func (c *dxgiCapturer) GetD3D11Context() uintptr {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.context
}
