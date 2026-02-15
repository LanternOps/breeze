//go:build windows

package desktop

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"math"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// WASAPI COM GUIDs
var (
	clsidMMDeviceEnumerator = comGUID{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator  = comGUID{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient         = comGUID{0x1CB9AD4C, 0xDBFA, 0x4c32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioCaptureClient  = comGUID{0xC8ADBD64, 0xE71E, 0x48a0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
)

// WASAPI constants
const (
	eRender         = 0
	eConsole        = 0
	audclntStreamLoopback    = 0x00020000
	audclntShareModeShared   = 0
	waveFormatIEEEFloat      = 0x0003
	waveFormatExtensible     = 0xFFFE

	// COM vtable indices (IUnknown = 0,1,2; interface methods start at 3)
	mmdeGetDefaultAudioEndpoint = 4  // IMMDeviceEnumerator::GetDefaultAudioEndpoint
	mmDeviceActivate            = 3  // IMMDevice::Activate
	audioClientInitialize       = 3  // IAudioClient::Initialize
	audioClientGetBufferSize    = 4  // IAudioClient::GetBufferSize
	audioClientGetMixFormat     = 8  // IAudioClient::GetMixFormat (after GetStreamLatency=5, GetCurrentPadding=6, IsFormatSupported=7)
	audioClientStart            = 10 // IAudioClient::Start (after GetDevicePeriod=9)
	audioClientStop             = 11 // IAudioClient::Stop
	audioClientGetService       = 14 // IAudioClient::GetService (after Reset=12, SetEventHandle=13)
	capClientGetBuffer          = 3  // IAudioCaptureClient::GetBuffer
	capClientReleaseBuffer      = 4  // IAudioCaptureClient::ReleaseBuffer
)

// WAVEFORMATEX layout
type waveFormatEx struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	CbSize         uint16
}

// wasapiCapturer captures system audio via WASAPI loopback.
type wasapiCapturer struct {
	mu            sync.Mutex
	started       bool
	enumerator    uintptr
	device        uintptr
	audioClient   uintptr
	captureClient uintptr
	mixFormat     *waveFormatEx

	done chan struct{}
	wg   sync.WaitGroup
}

// NewAudioCapturer creates a WASAPI loopback audio capturer.
func NewAudioCapturer() AudioCapturer {
	return &wasapiCapturer{done: make(chan struct{})}
}

func (w *wasapiCapturer) Start(callback func([]byte)) error {
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return fmt.Errorf("audio capturer already started")
	}
	w.started = true
	w.mu.Unlock()

	// Lock this goroutine to its OS thread for the lifetime of COM operations
	runtime.LockOSThread()

	// Initialize COM for this goroutine (S_FALSE = already initialized, which is OK)
	hr, _, _ := procCoInitializeEx.Call(0, 0) // COINIT_MULTITHREADED
	if int32(hr) < 0 {
		return fmt.Errorf("CoInitializeEx failed: 0x%08X", uint32(hr))
	}

	// Create MMDeviceEnumerator
	var enumerator uintptr
	hr, _, _ = syscall.SyscallN(
		procCoCreateInstance.Addr(),
		uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)),
		0, // pUnkOuter
		uintptr(0x1|0x2|0x4|0x10), // CLSCTX_ALL
		uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)),
		uintptr(unsafe.Pointer(&enumerator)),
	)
	if int32(hr) < 0 {
		return fmt.Errorf("CoCreateInstance MMDeviceEnumerator: 0x%08X", uint32(hr))
	}
	w.enumerator = enumerator

	// Get default render endpoint (for loopback capture)
	var device uintptr
	_, err := comCall(enumerator, mmdeGetDefaultAudioEndpoint,
		uintptr(eRender), uintptr(eConsole), uintptr(unsafe.Pointer(&device)))
	if err != nil {
		return fmt.Errorf("GetDefaultAudioEndpoint: %w", err)
	}
	w.device = device

	// Activate IAudioClient
	var audioClient uintptr
	_, err = comCall(device, mmDeviceActivate,
		uintptr(unsafe.Pointer(&iidIAudioClient)),
		uintptr(0x1|0x2|0x4|0x10), // CLSCTX_ALL
		0,
		uintptr(unsafe.Pointer(&audioClient)),
	)
	if err != nil {
		return fmt.Errorf("Activate IAudioClient: %w", err)
	}
	w.audioClient = audioClient

	// Get mix format
	var mixFormatPtr uintptr
	_, err = comCall(audioClient, audioClientGetMixFormat, uintptr(unsafe.Pointer(&mixFormatPtr)))
	if err != nil {
		return fmt.Errorf("GetMixFormat: %w", err)
	}
	// Copy by value so we own the struct (used after Initialize for capture loop config).
	fmtCopy := *(*waveFormatEx)(unsafe.Pointer(mixFormatPtr))
	w.mixFormat = &fmtCopy

	slog.Info("WASAPI mix format",
		"channels", w.mixFormat.Channels,
		"sampleRate", w.mixFormat.SamplesPerSec,
		"bitsPerSample", w.mixFormat.BitsPerSample,
		"formatTag", w.mixFormat.FormatTag,
	)

	// Initialize audio client in loopback mode (shared, event-driven)
	// 200ms buffer (in 100-ns units)
	bufferDuration := int64(200 * 10000) // 200ms
	_, err = comCall(audioClient, audioClientInitialize,
		uintptr(audclntShareModeShared),
		uintptr(audclntStreamLoopback),
		uintptr(bufferDuration),
		0, // periodicity
		mixFormatPtr, // must be valid COM memory — free AFTER Initialize
		0, // AudioSessionGuid
	)
	// Free COM memory now that Initialize has consumed it.
	procCoTaskMemFree.Call(mixFormatPtr)
	if err != nil {
		return fmt.Errorf("Initialize: %w", err)
	}

	// Get capture client
	var captureClient uintptr
	_, err = comCall(audioClient, audioClientGetService,
		uintptr(unsafe.Pointer(&iidIAudioCaptureClient)),
		uintptr(unsafe.Pointer(&captureClient)),
	)
	if err != nil {
		return fmt.Errorf("GetService IAudioCaptureClient: %w", err)
	}
	w.captureClient = captureClient

	// Start capture
	_, err = comCall(audioClient, audioClientStart)
	if err != nil {
		return fmt.Errorf("Start: %w", err)
	}

	// Capture loop in goroutine
	channels := int(w.mixFormat.Channels)
	sampleRate := int(w.mixFormat.SamplesPerSec)
	bitsPerSample := int(w.mixFormat.BitsPerSample)
	isFloat := w.mixFormat.FormatTag == waveFormatIEEEFloat ||
		(w.mixFormat.FormatTag == waveFormatExtensible && bitsPerSample == 32)

	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		// Lock goroutine to OS thread for COM apartment safety
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		// COM per-thread init
		hr, _, _ := procCoInitializeEx.Call(0, 0)
		if int32(hr) < 0 {
			slog.Error("Audio capture goroutine: CoInitializeEx failed", "hr", fmt.Sprintf("0x%08X", uint32(hr)))
			return
		}
		defer procCoUninitialize.Call()

		w.captureLoop(callback, channels, sampleRate, bitsPerSample, isFloat)
	}()

	return nil
}

func (w *wasapiCapturer) captureLoop(callback func([]byte), channels, sampleRate, bitsPerSample int, isFloat bool) {
	// We'll downsample to 8kHz mono μ-law (PCMU).
	// Accumulate raw samples, then downsample + encode in 20ms chunks (160 samples at 8kHz).
	const targetRate = 8000
	const frameSize = 160 // 20ms at 8kHz

	// Resampling: simple decimation with averaging
	ratio := float64(sampleRate) / float64(targetRate)
	var accum float64
	var accumCount int
	var outBuf [frameSize]byte
	outIdx := 0

	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-w.done:
			return
		case <-ticker.C:
		}

		for {
			var dataPtr uintptr
			var numFrames uint32
			var flags uint32

			hr, _, _ := syscall.SyscallN(
				comVtblFn(w.captureClient, capClientGetBuffer),
				w.captureClient,
				uintptr(unsafe.Pointer(&dataPtr)),
				uintptr(unsafe.Pointer(&numFrames)),
				uintptr(unsafe.Pointer(&flags)),
				0, // devicePosition
				0, // qpcPosition
			)
			if int32(hr) < 0 {
				if uint32(hr) == 0x88890004 { // AUDCLNT_E_DEVICE_INVALIDATED
					slog.Warn("Audio device invalidated, stopping capture")
					return
				}
				slog.Debug("WASAPI GetBuffer transient error", "hr", fmt.Sprintf("0x%08X", uint32(hr)))
				break // retry on next tick
			}
			if numFrames == 0 {
				break
			}

			silent := flags&0x2 != 0 // AUDCLNT_BUFFERFLAGS_SILENT

			bytesPerSample := bitsPerSample / 8
			bytesPerFrame := channels * bytesPerSample
			totalBytes := int(numFrames) * bytesPerFrame

			if !silent && dataPtr != 0 {
				raw := unsafe.Slice((*byte)(unsafe.Pointer(dataPtr)), totalBytes)
				for i := 0; i < int(numFrames); i++ {
					// Mix down to mono: average all channels
					var mono float64
					for ch := 0; ch < channels; ch++ {
						offset := i*bytesPerFrame + ch*bytesPerSample
						if isFloat && bytesPerSample == 4 {
							mono += float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[offset:])))
						} else if bytesPerSample == 2 {
							s16 := int16(binary.LittleEndian.Uint16(raw[offset:]))
							mono += float64(s16) / 32768.0
						}
					}
					mono /= float64(channels)

					// Accumulate for downsampling
					accum += mono
					accumCount++

					if float64(accumCount) >= ratio {
						avg := accum / float64(accumCount)
						// Clamp to [-1, 1]
						if avg > 1.0 {
							avg = 1.0
						} else if avg < -1.0 {
							avg = -1.0
						}
						// Convert to 16-bit PCM then to μ-law
						pcm16 := int16(avg * 32767.0)
						outBuf[outIdx] = linearToMulaw(pcm16)
						outIdx++
						accum = 0
						accumCount = 0

						if outIdx >= frameSize {
							frame := make([]byte, frameSize)
							copy(frame, outBuf[:])
							callback(frame)
							outIdx = 0
						}
					}
				}
			} else if silent {
				// Silent: generate silence frames
				for i := 0; i < int(numFrames); i++ {
					accumCount++
					if float64(accumCount) >= ratio {
						outBuf[outIdx] = 0xFF // μ-law silence
						outIdx++
						accumCount = 0
						if outIdx >= frameSize {
							frame := make([]byte, frameSize)
							copy(frame, outBuf[:])
							callback(frame)
							outIdx = 0
						}
					}
				}
			}

			// Release buffer
			relHr, _, _ := syscall.SyscallN(
				comVtblFn(w.captureClient, capClientReleaseBuffer),
				w.captureClient,
				uintptr(numFrames),
			)
			if int32(relHr) < 0 {
				slog.Warn("WASAPI ReleaseBuffer failed", "hr", fmt.Sprintf("0x%08X", uint32(relHr)))
				return // pipeline inconsistent, stop capture
			}
		}
	}
}

func (w *wasapiCapturer) Stop() {
	select {
	case <-w.done:
		return
	default:
		close(w.done)
	}
	w.wg.Wait()

	if w.audioClient != 0 {
		comCall(w.audioClient, audioClientStop)
	}
	if w.captureClient != 0 {
		comRelease(w.captureClient)
	}
	if w.audioClient != 0 {
		comRelease(w.audioClient)
	}
	if w.device != 0 {
		comRelease(w.device)
	}
	if w.enumerator != 0 {
		comRelease(w.enumerator)
	}
}

var procCoCreateInstance = ole32DLL.NewProc("CoCreateInstance")

// linearToMulaw converts a 16-bit signed PCM sample to μ-law encoding.
func linearToMulaw(sample int16) byte {
	const bias = 0x84
	const clip = 32635

	sign := byte(0)
	if sample < 0 {
		sign = 0x80
		sample = -sample
	}
	if sample > clip {
		sample = clip
	}
	sample += bias

	exp := 7
	for mask := int16(0x4000); exp > 0; exp-- {
		if sample&mask != 0 {
			break
		}
		mask >>= 1
	}
	mantissa := (sample >> (uint(exp) + 3)) & 0x0F
	return ^(sign | byte(exp<<4) | byte(mantissa))
}
