//go:build windows

package desktop

/*
#cgo LDFLAGS: -ld3d11 -ldxgi -lole32

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <stdlib.h>
#include <stdio.h>

// ScreenCaptureResult holds the capture result
typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
    char errorMsg[256];
} ScreenCaptureResult;

// Global D3D11 resources for efficiency
static ID3D11Device* g_device = NULL;
static ID3D11DeviceContext* g_context = NULL;
static IDXGIOutputDuplication* g_duplication = NULL;
static int g_initialized = 0;
static int g_screenWidth = 0;
static int g_screenHeight = 0;

// initDXGI initializes DXGI and D3D11 for screen capture
int initDXGI(int displayIndex) {
    if (g_initialized) {
        return 0;
    }

    HRESULT hr;

    // Create D3D11 device
    D3D_FEATURE_LEVEL featureLevels[] = { D3D_FEATURE_LEVEL_11_0 };
    D3D_FEATURE_LEVEL featureLevel;

    hr = D3D11CreateDevice(
        NULL,
        D3D_DRIVER_TYPE_HARDWARE,
        NULL,
        0,
        featureLevels,
        1,
        D3D11_SDK_VERSION,
        &g_device,
        &featureLevel,
        &g_context
    );

    if (FAILED(hr)) {
        return 1; // Failed to create D3D11 device
    }

    // Get DXGI device
    IDXGIDevice* dxgiDevice = NULL;
    hr = g_device->lpVtbl->QueryInterface(g_device, &IID_IDXGIDevice, (void**)&dxgiDevice);
    if (FAILED(hr)) {
        g_device->lpVtbl->Release(g_device);
        g_device = NULL;
        return 2;
    }

    // Get adapter
    IDXGIAdapter* adapter = NULL;
    hr = dxgiDevice->lpVtbl->GetAdapter(dxgiDevice, &adapter);
    dxgiDevice->lpVtbl->Release(dxgiDevice);
    if (FAILED(hr)) {
        g_device->lpVtbl->Release(g_device);
        g_device = NULL;
        return 3;
    }

    // Get output
    IDXGIOutput* output = NULL;
    hr = adapter->lpVtbl->EnumOutputs(adapter, displayIndex, &output);
    adapter->lpVtbl->Release(adapter);
    if (FAILED(hr)) {
        g_device->lpVtbl->Release(g_device);
        g_device = NULL;
        return 4; // Display not found
    }

    // Get output1 for duplication
    IDXGIOutput1* output1 = NULL;
    hr = output->lpVtbl->QueryInterface(output, &IID_IDXGIOutput1, (void**)&output1);

    // Get screen dimensions
    DXGI_OUTPUT_DESC desc;
    output->lpVtbl->GetDesc(output, &desc);
    g_screenWidth = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
    g_screenHeight = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;

    output->lpVtbl->Release(output);
    if (FAILED(hr)) {
        g_device->lpVtbl->Release(g_device);
        g_device = NULL;
        return 5;
    }

    // Create duplication
    hr = output1->lpVtbl->DuplicateOutput(output1, (IUnknown*)g_device, &g_duplication);
    output1->lpVtbl->Release(output1);
    if (FAILED(hr)) {
        g_device->lpVtbl->Release(g_device);
        g_device = NULL;
        return 6; // Failed to create duplication (possibly access denied)
    }

    g_initialized = 1;
    return 0;
}

// cleanupDXGI releases DXGI resources
void cleanupDXGI() {
    if (g_duplication) {
        g_duplication->lpVtbl->Release(g_duplication);
        g_duplication = NULL;
    }
    if (g_context) {
        g_context->lpVtbl->Release(g_context);
        g_context = NULL;
    }
    if (g_device) {
        g_device->lpVtbl->Release(g_device);
        g_device = NULL;
    }
    g_initialized = 0;
}

// captureScreen captures the screen using DXGI
ScreenCaptureResult captureScreen(int displayIndex) {
    ScreenCaptureResult result = {0};

    int initResult = initDXGI(displayIndex);
    if (initResult != 0) {
        result.error = initResult;
        return result;
    }

    HRESULT hr;
    IDXGIResource* desktopResource = NULL;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    // Acquire next frame
    hr = g_duplication->lpVtbl->AcquireNextFrame(g_duplication, 100, &frameInfo, &desktopResource);
    if (FAILED(hr)) {
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            // No new frame, try again
            hr = g_duplication->lpVtbl->AcquireNextFrame(g_duplication, 500, &frameInfo, &desktopResource);
        }
        if (FAILED(hr)) {
            result.error = 7; // Failed to acquire frame
            return result;
        }
    }

    // Get texture
    ID3D11Texture2D* desktopTexture = NULL;
    hr = desktopResource->lpVtbl->QueryInterface(desktopResource, &IID_ID3D11Texture2D, (void**)&desktopTexture);
    desktopResource->lpVtbl->Release(desktopResource);
    if (FAILED(hr)) {
        g_duplication->lpVtbl->ReleaseFrame(g_duplication);
        result.error = 8;
        return result;
    }

    // Get texture description
    D3D11_TEXTURE2D_DESC textureDesc;
    desktopTexture->lpVtbl->GetDesc(desktopTexture, &textureDesc);

    result.width = textureDesc.Width;
    result.height = textureDesc.Height;
    result.bytesPerRow = result.width * 4;

    // Create staging texture for CPU access
    D3D11_TEXTURE2D_DESC stagingDesc = textureDesc;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.BindFlags = 0;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    stagingDesc.MiscFlags = 0;

    ID3D11Texture2D* stagingTexture = NULL;
    hr = g_device->lpVtbl->CreateTexture2D(g_device, &stagingDesc, NULL, &stagingTexture);
    if (FAILED(hr)) {
        desktopTexture->lpVtbl->Release(desktopTexture);
        g_duplication->lpVtbl->ReleaseFrame(g_duplication);
        result.error = 9;
        return result;
    }

    // Copy to staging texture
    g_context->lpVtbl->CopyResource(g_context, (ID3D11Resource*)stagingTexture, (ID3D11Resource*)desktopTexture);
    desktopTexture->lpVtbl->Release(desktopTexture);

    // Map staging texture
    D3D11_MAPPED_SUBRESOURCE mappedResource;
    hr = g_context->lpVtbl->Map(g_context, (ID3D11Resource*)stagingTexture, 0, D3D11_MAP_READ, 0, &mappedResource);
    if (FAILED(hr)) {
        stagingTexture->lpVtbl->Release(stagingTexture);
        g_duplication->lpVtbl->ReleaseFrame(g_duplication);
        result.error = 10;
        return result;
    }

    // Allocate result data
    size_t dataSize = result.bytesPerRow * result.height;
    result.data = malloc(dataSize);
    if (result.data == NULL) {
        g_context->lpVtbl->Unmap(g_context, (ID3D11Resource*)stagingTexture, 0);
        stagingTexture->lpVtbl->Release(stagingTexture);
        g_duplication->lpVtbl->ReleaseFrame(g_duplication);
        result.error = 11;
        return result;
    }

    // Copy data (BGRA to RGBA conversion)
    unsigned char* src = (unsigned char*)mappedResource.pData;
    unsigned char* dst = (unsigned char*)result.data;
    for (int y = 0; y < result.height; y++) {
        for (int x = 0; x < result.width; x++) {
            int srcIdx = y * mappedResource.RowPitch + x * 4;
            int dstIdx = y * result.bytesPerRow + x * 4;
            dst[dstIdx + 0] = src[srcIdx + 2]; // R
            dst[dstIdx + 1] = src[srcIdx + 1]; // G
            dst[dstIdx + 2] = src[srcIdx + 0]; // B
            dst[dstIdx + 3] = src[srcIdx + 3]; // A
        }
    }

    // Cleanup
    g_context->lpVtbl->Unmap(g_context, (ID3D11Resource*)stagingTexture, 0);
    stagingTexture->lpVtbl->Release(stagingTexture);
    g_duplication->lpVtbl->ReleaseFrame(g_duplication);

    return result;
}

// getScreenBounds returns the screen dimensions
void getScreenBoundsW(int displayIndex, int* width, int* height, int* error) {
    *error = initDXGI(displayIndex);
    if (*error == 0) {
        *width = g_screenWidth;
        *height = g_screenHeight;
    }
}

// freeCapture frees the capture result data
void freeCapture(void* data) {
    if (data != NULL) {
        free(data);
    }
}
*/
import "C"

import (
	"fmt"
	"image"
	"sync"
)

// windowsCapturer implements ScreenCapturer for Windows using DXGI
type windowsCapturer struct {
	config CaptureConfig
	mu     sync.Mutex
}

// newPlatformCapturer creates a new Windows screen capturer
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return &windowsCapturer{config: config}, nil
}

// Capture captures the entire screen
func (c *windowsCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	result := C.captureScreen(C.int(c.config.DisplayIndex))

	if result.error != 0 {
		return nil, c.translateError(int(result.error))
	}

	defer C.freeCapture(result.data)

	return c.createImage(result)
}

// CaptureRegion captures a specific region of the screen
func (c *windowsCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	// Capture full screen then crop
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}

	// Create cropped image
	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		return nil, fmt.Errorf("region out of bounds")
	}

	cropped := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		for dx := 0; dx < width; dx++ {
			cropped.Set(dx, dy, fullImg.At(x+dx, y+dy))
		}
	}

	return cropped, nil
}

// GetScreenBounds returns the screen dimensions
func (c *windowsCapturer) GetScreenBounds() (width, height int, err error) {
	var cWidth, cHeight, cError C.int

	C.getScreenBoundsW(C.int(c.config.DisplayIndex), &cWidth, &cHeight, &cError)

	if cError != 0 {
		return 0, 0, c.translateError(int(cError))
	}

	return int(cWidth), int(cHeight), nil
}

// Close releases resources
func (c *windowsCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	C.cleanupDXGI()
	return nil
}

// createImage creates a Go image from the capture result
func (c *windowsCapturer) createImage(result C.ScreenCaptureResult) (*image.RGBA, error) {
	width := int(result.width)
	height := int(result.height)
	bytesPerRow := int(result.bytesPerRow)

	img := image.NewRGBA(image.Rect(0, 0, width, height))

	dataSize := bytesPerRow * height
	cData := C.GoBytes(result.data, C.int(dataSize))

	for y := 0; y < height; y++ {
		srcStart := y * bytesPerRow
		dstStart := y * img.Stride
		copy(img.Pix[dstStart:dstStart+width*4], cData[srcStart:srcStart+width*4])
	}

	return img, nil
}

// translateError converts C error codes to Go errors
func (c *windowsCapturer) translateError(code int) error {
	switch code {
	case 1:
		return fmt.Errorf("failed to create D3D11 device")
	case 2:
		return fmt.Errorf("failed to get DXGI device")
	case 3:
		return fmt.Errorf("failed to get DXGI adapter")
	case 4:
		return ErrDisplayNotFound
	case 5:
		return fmt.Errorf("failed to get DXGI output1")
	case 6:
		return ErrPermissionDenied
	case 7:
		return fmt.Errorf("failed to acquire frame")
	case 8:
		return fmt.Errorf("failed to get desktop texture")
	case 9:
		return fmt.Errorf("failed to create staging texture")
	case 10:
		return fmt.Errorf("failed to map texture")
	case 11:
		return fmt.Errorf("memory allocation failed")
	default:
		return fmt.Errorf("unknown error: %d", code)
	}
}

var _ ScreenCapturer = (*windowsCapturer)(nil)
