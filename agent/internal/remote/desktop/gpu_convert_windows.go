//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"syscall"
	"unsafe"
)

// gpuConverter uses the D3D11 Video Processor to convert BGRA textures to NV12
// entirely on the GPU, avoiding the CPU round-trip through Map/bgraToNV12.
type gpuConverter struct {
	videoDevice   uintptr // ID3D11VideoDevice
	videoContext  uintptr // ID3D11VideoContext
	processor     uintptr // ID3D11VideoProcessor
	enumerator    uintptr // ID3D11VideoProcessorEnumerator
	inputView     uintptr // ID3D11VideoProcessorInputView
	outputView    uintptr // ID3D11VideoProcessorOutputView
	nv12Texture   uintptr // ID3D11Texture2D (NV12, RENDER_TARGET)
	nv12Staging   uintptr // ID3D11Texture2D (NV12, STAGING, CPU_ACCESS_READ)
	d3dContext    uintptr // ID3D11DeviceContext (not owned, for CopyResource/Map)
	width, height int
	inited        bool
}

// newGPUConverter creates a GPU BGRA→NV12 converter using the D3D11 Video Processor.
// bgraTexture is the BGRA GPU texture (DEFAULT usage, RENDER_TARGET bind).
// context is the ID3D11DeviceContext for CopyResource/Map operations.
func newGPUConverter(device, context uintptr, bgraTexture uintptr, width, height int) (*gpuConverter, error) {
	g := &gpuConverter{width: width, height: height, d3dContext: context}

	// 1. QueryInterface → ID3D11VideoDevice
	var videoDevice uintptr
	_, err := comCall(device, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidID3D11VideoDevice)),
		uintptr(unsafe.Pointer(&videoDevice)),
	)
	if err != nil {
		return nil, fmt.Errorf("QueryInterface ID3D11VideoDevice: %w", err)
	}
	g.videoDevice = videoDevice

	// 2. QueryInterface → ID3D11VideoContext
	var videoContext uintptr
	_, err = comCall(context, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidID3D11VideoContext)),
		uintptr(unsafe.Pointer(&videoContext)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("QueryInterface ID3D11VideoContext: %w", err)
	}
	g.videoContext = videoContext

	// 3. Create video processor enumerator
	desc := d3d11VideoProcessorContentDesc{
		InputFrameFormat: 0, // PROGRESSIVE
		InputFrameRateN:  60,
		InputFrameRateD:  1,
		InputWidth:       uint32(width),
		InputHeight:      uint32(height),
		OutputFrameRateN: 60,
		OutputFrameRateD: 1,
		OutputWidth:      uint32(width),
		OutputHeight:     uint32(height),
		Usage:            0, // PLAYBACK_NORMAL
	}
	var enumerator uintptr
	_, err = comCall(videoDevice, vtblVidDevCreateVideoProcessorEnumerator,
		uintptr(unsafe.Pointer(&desc)),
		uintptr(unsafe.Pointer(&enumerator)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("CreateVideoProcessorEnumerator: %w", err)
	}
	g.enumerator = enumerator

	// 4. Create video processor
	var processor uintptr
	_, err = comCall(videoDevice, vtblVidDevCreateVideoProcessor,
		enumerator,
		0, // RateConversionIndex
		uintptr(unsafe.Pointer(&processor)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("CreateVideoProcessor: %w", err)
	}
	g.processor = processor

	// 5. Create NV12 output texture (RENDER_TARGET bind flag for video processor output)
	nv12Desc := d3d11Texture2DDesc{
		Width:          uint32(width),
		Height:         uint32(height),
		MipLevels:      1,
		ArraySize:      1,
		Format:         dxgiFormatNV12,
		SampleCount:    1,
		SampleQuality:  0,
		Usage:          0, // DEFAULT
		BindFlags:      d3d11BindRenderTarget,
		CPUAccessFlags: 0,
		MiscFlags:      0,
	}
	var nv12Texture uintptr
	_, err = comCall(device, d3d11DeviceCreateTexture2D,
		uintptr(unsafe.Pointer(&nv12Desc)),
		0, // pInitialData
		uintptr(unsafe.Pointer(&nv12Texture)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("CreateTexture2D NV12: %w", err)
	}
	g.nv12Texture = nv12Texture

	// 5b. Create NV12 staging texture for CPU readback
	nv12StagingDesc := d3d11Texture2DDesc{
		Width:          uint32(width),
		Height:         uint32(height),
		MipLevels:      1,
		ArraySize:      1,
		Format:         dxgiFormatNV12,
		SampleCount:    1,
		SampleQuality:  0,
		Usage:          d3d11UsageStaging,
		BindFlags:      0,
		CPUAccessFlags: d3d11CPUAccessRead,
		MiscFlags:      0,
	}
	var nv12Staging uintptr
	_, err = comCall(device, d3d11DeviceCreateTexture2D,
		uintptr(unsafe.Pointer(&nv12StagingDesc)),
		0,
		uintptr(unsafe.Pointer(&nv12Staging)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("CreateTexture2D NV12 staging: %w", err)
	}
	g.nv12Staging = nv12Staging

	// 6. Create input view (wraps BGRA GPU texture)
	// D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC: FourCC=0, ViewDimension=1(2D), Texture2D.MipSlice=0
	// NOTE: The native struct is 20 bytes (FourCC + ViewDimension + union[3]).
	// For Texture2D we only use MipSlice/ArraySlice, but we still pass the full size.
	inputViewDesc := [5]uint32{0, 1, 0, 0, 0} // FourCC, ViewDimension(TEXTURE2D), MipSlice, ArraySlice, padding/unused
	var inputView uintptr
	_, err = comCall(videoDevice, vtblVidDevCreateVideoProcessorInputView,
		bgraTexture,
		enumerator,
		uintptr(unsafe.Pointer(&inputViewDesc)),
		uintptr(unsafe.Pointer(&inputView)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("CreateVideoProcessorInputView: %w", err)
	}
	g.inputView = inputView

	// 7. Create output view (wraps NV12 texture)
	// D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC: ViewDimension=1(TEXTURE2D)
	// The native struct is 16 bytes (ViewDimension + union[3]).
	outputViewDesc := [4]uint32{1, 0, 0, 0} // ViewDimension(TEXTURE2D), MipSlice, FirstArraySlice, ArraySize
	var outputView uintptr
	_, err = comCall(videoDevice, vtblVidDevCreateVideoProcessorOutputView,
		nv12Texture,
		enumerator,
		uintptr(unsafe.Pointer(&outputViewDesc)),
		uintptr(unsafe.Pointer(&outputView)),
	)
	if err != nil {
		g.Close()
		return nil, fmt.Errorf("CreateVideoProcessorOutputView: %w", err)
	}
	g.outputView = outputView

	g.inited = true
	slog.Info("GPU color converter initialized", "width", width, "height", height)
	return g, nil
}

// Convert performs GPU BGRA→NV12 conversion using VideoProcessorBlt.
// Returns the NV12 texture handle. The returned texture is owned by gpuConverter.
func (g *gpuConverter) Convert() (uintptr, error) {
	if !g.inited {
		return 0, fmt.Errorf("GPU converter not initialized")
	}

	// Build stream struct
	stream := d3d11VideoProcessorStream{
		Enable:        1,
		PInputSurface: g.inputView,
	}

	// VideoProcessorBlt(processor, outputView, outputFrame=0, streamCount=1, &stream)
	ret, _, _ := syscall.SyscallN(
		comVtblFn(g.videoContext, vtblVidCtxVideoProcessorBlt),
		g.videoContext,
		g.processor,
		g.outputView,
		0, // OutputFrame
		1, // StreamCount
		uintptr(unsafe.Pointer(&stream)),
	)
	if int32(ret) < 0 {
		return 0, fmt.Errorf("VideoProcessorBlt: 0x%08X", uint32(ret))
	}

	return g.nv12Texture, nil
}

// ConvertAndReadback performs GPU BGRA→NV12 conversion and reads the result
// back to CPU memory. Returns NV12 pixel data (width*height*3/2 bytes).
// This avoids DXGI surface buffer issues with hardware MFT encoders.
func (g *gpuConverter) ConvertAndReadback() ([]byte, error) {
	if !g.inited {
		return nil, fmt.Errorf("GPU converter not initialized")
	}

	// 1. VideoProcessorBlt: BGRA → NV12 on GPU
	stream := d3d11VideoProcessorStream{
		Enable:        1,
		PInputSurface: g.inputView,
	}
	ret, _, _ := syscall.SyscallN(
		comVtblFn(g.videoContext, vtblVidCtxVideoProcessorBlt),
		g.videoContext,
		g.processor,
		g.outputView,
		0, // OutputFrame
		1, // StreamCount
		uintptr(unsafe.Pointer(&stream)),
	)
	if int32(ret) < 0 {
		return nil, fmt.Errorf("VideoProcessorBlt: 0x%08X", uint32(ret))
	}

	// 2. CopyResource: NV12 render target → NV12 staging (GPU-to-GPU)
	syscall.SyscallN(
		comVtblFn(g.d3dContext, d3d11CtxCopyResource),
		g.d3dContext,
		g.nv12Staging,
		g.nv12Texture,
	)

	// 3. Map staging texture to read NV12 data
	var mapped d3d11MappedSubresource
	hr, _, _ := syscall.SyscallN(
		comVtblFn(g.d3dContext, d3d11CtxMap),
		g.d3dContext,
		g.nv12Staging,
		0, // Subresource
		1, // D3D11_MAP_READ
		0, // Flags
		uintptr(unsafe.Pointer(&mapped)),
	)
	if int32(hr) < 0 {
		return nil, fmt.Errorf("Map NV12 staging: 0x%08X", uint32(hr))
	}

	// 4. Copy NV12 data to Go slice
	// NV12 layout: Y plane (width*height) + UV plane (width*height/2)
	nv12Size := g.width * g.height * 3 / 2
	rowPitch := int(mapped.RowPitch)

	nv12 := getNV12Buffer(g.width, g.height)

	if rowPitch == g.width {
		// Fast path: Y plane has no padding, single copy for Y plane
		ySize := g.width * g.height
		src := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData)), rowPitch*g.height+rowPitch*(g.height/2))
		copy(nv12[:ySize], src[:ySize])
		// UV plane starts at rowPitch * height in the mapped data
		uvSrc := src[rowPitch*g.height:]
		copy(nv12[ySize:], uvSrc[:g.width*(g.height/2)])
	} else {
		// Row-by-row copy handling stride padding
		// Y plane: height rows, width bytes each
		for y := 0; y < g.height; y++ {
			srcRow := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData+uintptr(y*rowPitch))), g.width)
			copy(nv12[y*g.width:], srcRow)
		}
		// UV plane: height/2 rows, width bytes each (interleaved U/V)
		uvOffset := g.width * g.height
		uvSrcBase := mapped.PData + uintptr(g.height*rowPitch)
		for y := 0; y < g.height/2; y++ {
			srcRow := unsafe.Slice((*byte)(unsafe.Pointer(uvSrcBase+uintptr(y*rowPitch))), g.width)
			copy(nv12[uvOffset+y*g.width:], srcRow)
		}
	}

	// 5. Unmap
	syscall.SyscallN(comVtblFn(g.d3dContext, d3d11CtxUnmap), g.d3dContext, g.nv12Staging, 0)

	_ = nv12Size // sanity: nv12 slice is exactly this size
	return nv12, nil
}

// Close releases all D3D11 video processor resources.
func (g *gpuConverter) Close() {
	if g.outputView != 0 {
		comRelease(g.outputView)
		g.outputView = 0
	}
	if g.inputView != 0 {
		comRelease(g.inputView)
		g.inputView = 0
	}
	if g.nv12Staging != 0 {
		comRelease(g.nv12Staging)
		g.nv12Staging = 0
	}
	if g.nv12Texture != 0 {
		comRelease(g.nv12Texture)
		g.nv12Texture = 0
	}
	if g.processor != 0 {
		comRelease(g.processor)
		g.processor = 0
	}
	if g.enumerator != 0 {
		comRelease(g.enumerator)
		g.enumerator = 0
	}
	if g.videoContext != 0 {
		comRelease(g.videoContext)
		g.videoContext = 0
	}
	if g.videoDevice != 0 {
		comRelease(g.videoDevice)
		g.videoDevice = 0
	}
	g.inited = false
}
