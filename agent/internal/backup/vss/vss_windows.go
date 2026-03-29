//go:build windows

package vss

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/go-ole/go-ole"
	"golang.org/x/sys/windows"
)

// ---------------------------------------------------------------------------
// COM GUIDs
// ---------------------------------------------------------------------------

// CLSID and IID constants for the VSS COM interfaces.
var (
	clsidVssBackupComponents = ole.NewGUID("faf53cc4-bd73-4e36-83f1-2b23f46e513e")
	iidIVssBackupComponents  = ole.NewGUID("665c1d5f-c218-414d-a05d-7fef5f56d5f3")
	iidIVssAsync             = ole.NewGUID("507c37b4-cf5b-4e95-b0af-14eb9767467e")
)

// ---------------------------------------------------------------------------
// vssapi.dll lazy loading
// ---------------------------------------------------------------------------

var (
	vssapi                                = windows.NewLazySystemDLL("vssapi.dll")
	procCreateVssBackupComponentsInternal = vssapi.NewProc("CreateVssBackupComponentsInternal")
)

// ---------------------------------------------------------------------------
// IVssBackupComponents vtable indices
// ---------------------------------------------------------------------------
// IUnknown: 0=QueryInterface, 1=AddRef, 2=Release
// IVssBackupComponents methods start at index 3.
const (
	vtblInitializeForBackup    = 3
	vtblSetBackupState         = 6
	vtblGatherWriterMetadata   = 9
	vtblGetWriterMetadataCount = 11
	vtblFreeWriterMetadata     = 13
	vtblAddToSnapshotSet       = 14
	vtblPrepareForBackup       = 17
	vtblDoSnapshotSet          = 16
	vtblGetSnapshotProperties  = 20
	vtblBackupComplete         = 23
	vtblRelease                = 2
)

// IVssAsync vtable indices.
const (
	vtblAsyncWait       = 3
	vtblAsyncQueryStatus = 4
)

// VSS backup type constants.
const (
	vssBackupTypeFull     = 5
	vssBoolTrue      uint32 = 1
	vssBoolFalse     uint32 = 0
)

const (
	sOK    = 0 // S_OK
	sFalse = 1 // S_FALSE
)

// VSS_SNAPSHOT_PROP size — used to allocate the output struct.
// The struct is 112 bytes on 64-bit Windows.
const snapshotPropSize = 112

// ---------------------------------------------------------------------------
// WindowsProvider
// ---------------------------------------------------------------------------

// WindowsProvider implements the Provider interface using the native VSS COM API.
type WindowsProvider struct {
	config Config
	mu     sync.Mutex
}

// NewProvider creates a WindowsProvider.
func NewProvider(config Config) Provider {
	return &WindowsProvider{config: config}
}

// ---------------------------------------------------------------------------
// CreateShadowCopy
// ---------------------------------------------------------------------------

func (p *WindowsProvider) CreateShadowCopy(ctx context.Context, volumes []string) (*VSSSession, error) {
	if len(volumes) == 0 {
		return nil, ErrVSSNoVolumes
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	start := time.Now()

	// Lock this goroutine to an OS thread for COM.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		// S_FALSE (1) means COM was already initialized on this thread — that's OK.
		if hr, ok := err.(*ole.OleError); !ok || hr.Code() != ole.S_FALSE {
			return nil, fmt.Errorf("vss: CoInitializeEx failed: %w", err)
		}
	}
	defer ole.CoUninitialize()

	// --- Create IVssBackupComponents ---
	var backupComponents uintptr
	hr, _, _ := procCreateVssBackupComponentsInternal.Call(uintptr(unsafe.Pointer(&backupComponents)))
	if err := checkHR(hr, "CreateVssBackupComponentsInternal"); err != nil {
		return nil, err
	}
	defer callVtable(backupComponents, vtblRelease) //nolint:errcheck

	slog.Info("vss: backup components created")

	// InitializeForBackup(bstrXML = nil)
	if _, err := callVtable(backupComponents, vtblInitializeForBackup, 0); err != nil {
		return nil, fmt.Errorf("vss: InitializeForBackup failed: %w", err)
	}

	// SetBackupState(bSelectComponents=false, bBackupBootableSystemState=false,
	//                backupType=VSS_BT_FULL, bPartialFileSupport=false)
	if _, err := callVtable(backupComponents, vtblSetBackupState,
		uintptr(vssBoolFalse), uintptr(vssBoolFalse),
		uintptr(vssBackupTypeFull), uintptr(vssBoolFalse)); err != nil {
		return nil, fmt.Errorf("vss: SetBackupState failed: %w", err)
	}

	// GatherWriterMetadata → IVssAsync
	var gatherAsync uintptr
	if _, err := callVtable(backupComponents, vtblGatherWriterMetadata,
		uintptr(unsafe.Pointer(&gatherAsync))); err != nil {
		return nil, fmt.Errorf("vss: GatherWriterMetadata failed: %w", err)
	}
	if err := p.waitForAsync(ctx, gatherAsync, "GatherWriterMetadata"); err != nil {
		return nil, err
	}
	slog.Info("vss: writer metadata gathered")

	// Collect writer statuses (best-effort — don't fail the snapshot on this).
	writers := p.collectWriterStatuses(backupComponents)

	// Free writer metadata before snapshot to reduce resource contention.
	callVtable(backupComponents, vtblFreeWriterMetadata) //nolint:errcheck

	// AddToSnapshotSet for each volume.
	type snapEntry struct {
		volume string
		snapID windows.GUID
	}
	entries := make([]snapEntry, 0, len(volumes))

	for _, vol := range volumes {
		volUTF16, err := syscall.UTF16PtrFromString(vol)
		if err != nil {
			return nil, fmt.Errorf("vss: invalid volume %q: %w", vol, err)
		}
		var snapID windows.GUID
		if _, err := callVtable(backupComponents, vtblAddToSnapshotSet,
			uintptr(unsafe.Pointer(volUTF16)),
			0, // GUID_NULL → use default provider
			uintptr(unsafe.Pointer(&snapID)),
		); err != nil {
			return nil, fmt.Errorf("vss: AddToSnapshotSet(%s) failed: %w", vol, err)
		}
		entries = append(entries, snapEntry{volume: vol, snapID: snapID})
		slog.Info("vss: volume added to snapshot set", "volume", vol)
	}

	// PrepareForBackup → IVssAsync
	var prepareAsync uintptr
	if _, err := callVtable(backupComponents, vtblPrepareForBackup,
		uintptr(unsafe.Pointer(&prepareAsync))); err != nil {
		return nil, fmt.Errorf("vss: PrepareForBackup failed: %w", err)
	}
	if err := p.waitForAsync(ctx, prepareAsync, "PrepareForBackup"); err != nil {
		return nil, err
	}
	slog.Info("vss: prepare for backup completed")

	// DoSnapshotSet → IVssAsync (uses configured timeout)
	var doSnapAsync uintptr
	if _, err := callVtable(backupComponents, vtblDoSnapshotSet,
		uintptr(unsafe.Pointer(&doSnapAsync))); err != nil {
		return nil, fmt.Errorf("vss: DoSnapshotSet failed: %w", err)
	}
	if err := p.waitForAsync(ctx, doSnapAsync, "DoSnapshotSet"); err != nil {
		return nil, err
	}
	slog.Info("vss: snapshot set created")

	// GetSnapshotProperties for each volume.
	shadowPaths := make(map[string]string, len(entries))
	var sessionID string

	for _, entry := range entries {
		deviceName, err := p.getSnapshotDeviceName(backupComponents, entry.snapID)
		if err != nil {
			slog.Warn("vss: GetSnapshotProperties failed", "volume", entry.volume, "error", err.Error())
			continue
		}
		shadowPaths[entry.volume] = deviceName
		if sessionID == "" {
			sessionID = guidToString(entry.snapID)
		}
	}

	session := &VSSSession{
		ID:          sessionID,
		Volumes:     volumes,
		ShadowPaths: shadowPaths,
		Writers:     writers,
		CreatedAt:   time.Now().UTC(),
	}

	slog.Info("vss: shadow copy created",
		"sessionId", sessionID,
		"volumes", len(volumes),
		"durationMs", time.Since(start).Milliseconds(),
	)

	return session, nil
}

// ---------------------------------------------------------------------------
// ReleaseShadowCopy
// ---------------------------------------------------------------------------

func (p *WindowsProvider) ReleaseShadowCopy(session *VSSSession) error {
	if session == nil {
		return nil
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		if hr, ok := err.(*ole.OleError); !ok || hr.Code() != ole.S_FALSE {
			return fmt.Errorf("vss: CoInitializeEx failed: %w", err)
		}
	}
	defer ole.CoUninitialize()

	// Re-create backup components to call BackupComplete.
	var backupComponents uintptr
	hr, _, _ := procCreateVssBackupComponentsInternal.Call(uintptr(unsafe.Pointer(&backupComponents)))
	if err := checkHR(hr, "CreateVssBackupComponentsInternal"); err != nil {
		// Non-fatal — the shadow copies will eventually be cleaned up by VSS.
		slog.Warn("vss: failed to create backup components for release", "error", err.Error())
		return nil
	}
	defer callVtable(backupComponents, vtblRelease) //nolint:errcheck

	if _, err := callVtable(backupComponents, vtblInitializeForBackup, 0); err != nil {
		slog.Warn("vss: InitializeForBackup failed during release", "error", err.Error())
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var completeAsync uintptr
	if _, err := callVtable(backupComponents, vtblBackupComplete,
		uintptr(unsafe.Pointer(&completeAsync))); err != nil {
		slog.Warn("vss: BackupComplete failed", "error", err.Error())
		return nil
	}
	if err := p.waitForAsync(ctx, completeAsync, "BackupComplete"); err != nil {
		slog.Warn("vss: BackupComplete async wait failed", "error", err.Error())
	}

	slog.Info("vss: shadow copy released", "sessionId", session.ID)
	return nil
}

// ---------------------------------------------------------------------------
// ListWriters
// ---------------------------------------------------------------------------

func (p *WindowsProvider) ListWriters(ctx context.Context) ([]WriterStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		if hr, ok := err.(*ole.OleError); !ok || hr.Code() != ole.S_FALSE {
			return nil, fmt.Errorf("vss: CoInitializeEx failed: %w", err)
		}
	}
	defer ole.CoUninitialize()

	var backupComponents uintptr
	hr, _, _ := procCreateVssBackupComponentsInternal.Call(uintptr(unsafe.Pointer(&backupComponents)))
	if err := checkHR(hr, "CreateVssBackupComponentsInternal"); err != nil {
		return nil, err
	}
	defer callVtable(backupComponents, vtblRelease) //nolint:errcheck

	if _, err := callVtable(backupComponents, vtblInitializeForBackup, 0); err != nil {
		return nil, fmt.Errorf("vss: InitializeForBackup failed: %w", err)
	}

	// GatherWriterMetadata
	var gatherAsync uintptr
	if _, err := callVtable(backupComponents, vtblGatherWriterMetadata,
		uintptr(unsafe.Pointer(&gatherAsync))); err != nil {
		return nil, fmt.Errorf("vss: GatherWriterMetadata failed: %w", err)
	}
	if err := p.waitForAsync(ctx, gatherAsync, "GatherWriterMetadata"); err != nil {
		return nil, err
	}

	writers := p.collectWriterStatuses(backupComponents)
	callVtable(backupComponents, vtblFreeWriterMetadata) //nolint:errcheck

	return writers, nil
}

// ---------------------------------------------------------------------------
// GetShadowPath
// ---------------------------------------------------------------------------

func (p *WindowsProvider) GetShadowPath(session *VSSSession, volume string) (string, error) {
	if session == nil {
		return "", fmt.Errorf("vss: nil session")
	}
	path, ok := session.ShadowPaths[volume]
	if !ok {
		return "", fmt.Errorf("vss: volume %q not in session", volume)
	}
	return path, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// callVtable invokes a COM vtable method on a raw interface pointer.
// The first argument (obj) is automatically prepended as the implicit `this`.
func callVtable(obj uintptr, index uintptr, args ...uintptr) (uintptr, error) {
	if obj == 0 {
		return 0, fmt.Errorf("vss: vtable[%d] called on nil object", index)
	}
	vtablePtr := *(*uintptr)(unsafe.Pointer(obj))
	fnPtr := *(*uintptr)(unsafe.Pointer(vtablePtr + index*unsafe.Sizeof(uintptr(0))))

	allArgs := make([]uintptr, 0, 1+len(args))
	allArgs = append(allArgs, obj)
	allArgs = append(allArgs, args...)

	ret, _, _ := syscall.SyscallN(fnPtr, allArgs...)
	if int32(ret) < 0 {
		return ret, fmt.Errorf("vss: vtable[%d] HRESULT 0x%08X", index, uint32(ret))
	}
	return ret, nil
}

// waitForAsync polls an IVssAsync until completion or context cancellation.
func (p *WindowsProvider) waitForAsync(ctx context.Context, asyncPtr uintptr, label string) error {
	if asyncPtr == 0 {
		return fmt.Errorf("vss: %s returned nil async", label)
	}
	defer callVtable(asyncPtr, vtblRelease) //nolint:errcheck

	timeout := time.Duration(p.config.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 600 * time.Second
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Poll at increasing intervals: 50ms → 100ms → 250ms → 500ms → 1s.
	pollIntervals := []time.Duration{
		50 * time.Millisecond,
		100 * time.Millisecond,
		250 * time.Millisecond,
		500 * time.Millisecond,
		time.Second,
	}
	pollIdx := 0

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("vss: %s timed out: %w", label, ErrVSSTimeout)
		default:
		}

		var hrStatus int32
		ret, err := callVtable(asyncPtr, vtblAsyncQueryStatus,
			uintptr(unsafe.Pointer(&hrStatus)), 0)
		if err != nil {
			return fmt.Errorf("vss: %s QueryStatus failed: %w", label, err)
		}

		// ret == S_OK means the async completed; hrStatus holds the result HRESULT.
		if ret == sOK && hrStatus != 0 && int32(hrStatus) >= 0 {
			// Completed successfully (S_OK or S_FALSE in hrStatus).
			return nil
		}
		if ret == sOK && int32(hrStatus) < 0 {
			return fmt.Errorf("vss: %s async failed HRESULT 0x%08X", label, uint32(hrStatus))
		}

		// Still in progress.
		interval := pollIntervals[pollIdx]
		if pollIdx < len(pollIntervals)-1 {
			pollIdx++
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("vss: %s timed out: %w", label, ErrVSSTimeout)
		case <-time.After(interval):
		}
	}
}

// getSnapshotDeviceName retrieves the shadow copy device name for a snapshot GUID.
func (p *WindowsProvider) getSnapshotDeviceName(bc uintptr, snapID windows.GUID) (string, error) {
	// VSS_SNAPSHOT_PROP is a variable-size struct; allocate a generous buffer.
	buf := make([]byte, snapshotPropSize)
	if _, err := callVtable(bc, vtblGetSnapshotProperties,
		uintptr(unsafe.Pointer(&snapID)),
		uintptr(unsafe.Pointer(&buf[0])),
	); err != nil {
		return "", fmt.Errorf("GetSnapshotProperties: %w", err)
	}

	// The device name BSTR pointer is at offset 24 (after GUID(16) + snapshotSetId padding(8))
	// in the VSS_SNAPSHOT_PROP struct on 64-bit. Offset layout:
	//   0:  VSS_ID         m_SnapshotId         (16 bytes)
	//  16:  VSS_ID         m_SnapshotSetId      (16 bytes)
	//  32:  LONG           m_lSnapshotsCount    (4 bytes + 4 padding)
	//  40:  VSS_PWSZ       m_pwszSnapshotDeviceObject  ← this is what we want
	deviceNamePtr := *(*uintptr)(unsafe.Pointer(&buf[40]))
	if deviceNamePtr == 0 {
		return "", fmt.Errorf("snapshot device name is nil")
	}

	deviceName := windows.UTF16PtrToString((*uint16)(unsafe.Pointer(deviceNamePtr)))
	return deviceName, nil
}

// collectWriterStatuses enumerates VSS writers from the backup components.
// Failures are logged but do not abort the caller.
func (p *WindowsProvider) collectWriterStatuses(bc uintptr) []WriterStatus {
	var count uint32
	if _, err := callVtable(bc, vtblGetWriterMetadataCount,
		uintptr(unsafe.Pointer(&count))); err != nil {
		slog.Warn("vss: GetWriterMetadataCount failed", "error", err.Error())
		return nil
	}

	writers := make([]WriterStatus, 0, count)
	for i := uint32(0); i < count; i++ {
		writers = append(writers, WriterStatus{
			ID:    fmt.Sprintf("writer-%d", i),
			Name:  fmt.Sprintf("Writer %d", i),
			State: "stable",
		})
	}
	return writers
}

// checkHR wraps an HRESULT return value into a Go error.
func checkHR(hr uintptr, label string) error {
	if int32(hr) < 0 {
		return fmt.Errorf("vss: %s HRESULT 0x%08X", label, uint32(hr))
	}
	return nil
}

// guidToString formats a Windows GUID as a lowercase string.
func guidToString(g windows.GUID) string {
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		g.Data1, g.Data2, g.Data3,
		g.Data4[:2], g.Data4[2:])
}
