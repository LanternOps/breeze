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
// vssapi.dll lazy loading
// ---------------------------------------------------------------------------

var (
	vssapi                                = windows.NewLazySystemDLL("vssapi.dll")
	procCreateVssBackupComponentsInternal = vssapi.NewProc("CreateVssBackupComponentsInternal")
	procVssFreeSnapshotProperties         = vssapi.NewProc("VssFreeSnapshotProperties")

	oleaut32          = windows.NewLazySystemDLL("oleaut32.dll")
	procSysFreeString = oleaut32.NewProc("SysFreeString")
)

// ---------------------------------------------------------------------------
// IVssBackupComponents vtable indices
// ---------------------------------------------------------------------------
//
// These indices are the declaration order of the pure-virtual methods in
// `IVssBackupComponents` (Windows SDK `vsbackup.h`), offset by the three
// IUnknown slots (0=QueryInterface, 1=AddRef, 2=Release).
//
// Getting these wrong does not fail to compile and does not fail to link — it
// silently calls a *different* COM method, which is how issue #2999 shipped:
// `InitializeForBackup` was mapped to slot 3, which is really
// `GetWriterComponentsCount(OUT UINT*)`. Passing the intended NULL BSTR to it
// produced a synchronous `E_INVALIDARG` (0x80070057) on every backup run.
//
// Do not renumber these by hand. The full declaration order is listed below so
// that any future addition can be counted against the header rather than
// guessed:
//
//	 3 GetWriterComponentsCount   4 GetWriterComponents      5 InitializeForBackup
//	 6 SetBackupState             7 InitializeForRestore     8 SetRestoreState
//	 9 GatherWriterMetadata      10 GetWriterMetadataCount  11 GetWriterMetadata
//	12 FreeWriterMetadata        13 AddComponent            14 PrepareForBackup
//	15 AbortBackup               16 GatherWriterStatus      17 GetWriterStatusCount
//	18 FreeWriterStatus          19 GetWriterStatus         20 SetBackupSucceeded
//	21 SetBackupOptions          22 SetSelectedForRestore   23 SetRestoreOptions
//	24 SetAdditionalRestores     25 SetPreviousBackupStamp  26 SaveAsXML
//	27 BackupComplete            28 AddAlternativeLocationMapping
//	29 AddRestoreSubcomponent    30 SetFileRestoreStatus    31 AddNewTarget
//	32 SetRangesFilePath         33 PreRestore             34 PostRestore
//	35 SetContext                36 StartSnapshotSet       37 AddToSnapshotSet
//	38 DoSnapshotSet             39 DeleteSnapshots        40 ImportSnapshots
//	41 BreakSnapshotSet          42 GetSnapshotProperties  43 Query
//	44 IsVolumeSupported         45 DisableWriterClasses   46 EnableWriterClasses
//	47 DisableWriterInstances    48 ExposeSnapshot         49 RevertToSnapshot
//	50 QueryRevertStatus
const (
	vtblRelease               = 2
	vtblInitializeForBackup   = 5
	vtblSetBackupState        = 6
	vtblGatherWriterMetadata  = 9
	vtblFreeWriterMetadata    = 12
	vtblPrepareForBackup      = 14
	vtblAbortBackup           = 15
	vtblGatherWriterStatus    = 16
	vtblGetWriterStatusCount  = 17
	vtblFreeWriterStatus      = 18
	vtblGetWriterStatus       = 19
	vtblBackupComplete        = 27
	vtblStartSnapshotSet      = 36
	vtblAddToSnapshotSet      = 37
	vtblDoSnapshotSet         = 38
	vtblGetSnapshotProperties = 42
)

// IVssAsync vtable indices (`vss.h`): 3=Cancel, 4=Wait, 5=QueryStatus.
const (
	vtblAsyncCancel      = 3
	vtblAsyncWait        = 4
	vtblAsyncQueryStatus = 5
)

// VSS_BACKUP_TYPE values (`vss.h`).
//
// Note that VSS_BT_FULL is 1, not 5 — 5 is VSS_BT_COPY. Breeze takes
// file-level copies and must not disturb the writers' incremental backup
// chains (e.g. by causing log truncation), so VSS_BT_COPY is the correct
// choice here; it is now named accurately.
const (
	vssBackupTypeFull = 1
	vssBackupTypeCopy = 5
)

const (
	vssBoolTrue  uintptr = 1
	vssBoolFalse uintptr = 0
)

const (
	sOK    = 0 // S_OK
	sFalse = 1 // S_FALSE
)

// IVssAsync QueryStatus result codes (`vss.h`).
const (
	vssSAsyncPending   uint32 = 0x00042309
	vssSAsyncFinished  uint32 = 0x0004230A
	vssSAsyncCancelled uint32 = 0x0004230B
)

// VSS_WRITER_STATE values (`vss.h`). Anything >= vssWsFailedAtIdentify is a
// failure state.
const (
	vssWsStable            uint32 = 1
	vssWsFailedAtIdentify  uint32 = 6
	vssWsFailedAtBackupEnd uint32 = 15
)

// ---------------------------------------------------------------------------
// VSS_SNAPSHOT_PROP
// ---------------------------------------------------------------------------

// vssSnapshotProp mirrors VSS_SNAPSHOT_PROP from `vss.h` for 64-bit Windows.
//
// The string fields are declared as uintptr rather than *uint16 on purpose:
// VSS fills them with CoTaskMemAlloc'd pointers that the Go garbage collector
// must not attempt to trace.
//
// Previously this struct was a hand-allocated 112-byte []byte with the device
// name read at a magic offset. The real struct is 128 bytes, so VSS wrote 16
// bytes past the end of that buffer on every successful GetSnapshotProperties
// call. Using a typed struct makes the size the compiler's problem.
type vssSnapshotProp struct {
	SnapshotID           windows.GUID // 0
	SnapshotSetID        windows.GUID // 16
	SnapshotsCount       int32        // 32
	_                    int32        // 36 (padding)
	SnapshotDeviceObject uintptr      // 40  VSS_PWSZ
	OriginalVolumeName   uintptr      // 48  VSS_PWSZ
	OriginatingMachine   uintptr      // 56  VSS_PWSZ
	ServiceMachine       uintptr      // 64  VSS_PWSZ
	ExposedName          uintptr      // 72  VSS_PWSZ
	ExposedPath          uintptr      // 80  VSS_PWSZ
	ProviderID           windows.GUID // 88
	SnapshotAttributes   int32        // 104
	_                    int32        // 108 (padding)
	CreationTimestamp    int64        // 112
	Status               int32        // 120
	_                    int32        // 124 (padding)
} // 128 bytes

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
		if hr, ok := err.(*ole.OleError); !ok || hr.Code() != sFalse {
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
	if backupComponents == 0 {
		return nil, fmt.Errorf("vss: CreateVssBackupComponentsInternal returned a nil interface")
	}

	// The shadow copies created below are non-persistent and live for as long
	// as this process does, so releasing the components object here is safe:
	// breeze-backup runs one job per process and the caller only needs the
	// shadow device paths.
	defer callVtable(backupComponents, vtblRelease) //nolint:errcheck

	slog.Info("vss: backup components created")

	// InitializeForBackup(bstrXML = NULL)
	if _, err := callVtable(backupComponents, vtblInitializeForBackup, 0); err != nil {
		return nil, fmt.Errorf("vss: InitializeForBackup failed: %w", err)
	}

	// SetBackupState(bSelectComponents=false, bBackupBootableSystemState=false,
	//                backupType=VSS_BT_COPY, bPartialFileSupport=false)
	if _, err := callVtable(backupComponents, vtblSetBackupState,
		vssBoolFalse, vssBoolFalse,
		uintptr(vssBackupTypeCopy), vssBoolFalse); err != nil {
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

	// StartSnapshotSet must precede AddToSnapshotSet; without it every
	// AddToSnapshotSet call fails with VSS_E_BAD_STATE.
	var snapshotSetID windows.GUID
	if _, err := callVtable(backupComponents, vtblStartSnapshotSet,
		uintptr(unsafe.Pointer(&snapshotSetID))); err != nil {
		return nil, fmt.Errorf("vss: StartSnapshotSet failed: %w", err)
	}

	// Any failure from here on leaves a half-built snapshot set that the
	// writers are holding state for; tell them to stand down.
	snapshotSetStarted := true
	defer func() {
		if snapshotSetStarted {
			callVtable(backupComponents, vtblAbortBackup) //nolint:errcheck
		}
	}()

	// AddToSnapshotSet for each volume.
	type snapEntry struct {
		volume string
		snapID windows.GUID
	}
	entries := make([]snapEntry, 0, len(volumes))

	// GUID_NULL selects the default (system) provider. VSS_ID is a 16-byte
	// struct passed *by value*, which the x64 calling convention marshals as a
	// hidden pointer — so this must be the address of a zeroed GUID, never a
	// literal 0.
	var guidNull windows.GUID

	for _, vol := range volumes {
		// AddToSnapshotSet requires a volume mount point — a drive letter must
		// carry its trailing backslash. The caller derives volumes with
		// filepath.VolumeName, which yields "C:" (no separator); passing that
		// through verbatim fails with VSS_E_OBJECT_NOT_FOUND. Normalise for the
		// COM call but key the session map on the caller's original string, or
		// the caller's own shadow-path lookup misses and it silently falls back
		// to reading the live volume.
		mountPoint := volumeMountPoint(vol)
		volUTF16, err := syscall.UTF16PtrFromString(mountPoint)
		if err != nil {
			return nil, fmt.Errorf("vss: invalid volume %q: %w", vol, err)
		}
		var snapID windows.GUID
		_, callErr := callVtable(backupComponents, vtblAddToSnapshotSet,
			uintptr(unsafe.Pointer(volUTF16)),
			uintptr(unsafe.Pointer(&guidNull)),
			uintptr(unsafe.Pointer(&snapID)),
		)
		runtime.KeepAlive(volUTF16)
		if callErr != nil {
			return nil, fmt.Errorf("vss: AddToSnapshotSet(%s) failed: %w", mountPoint, callErr)
		}
		entries = append(entries, snapEntry{volume: vol, snapID: snapID})
		slog.Info("vss: volume added to snapshot set", "volume", vol, "mountPoint", mountPoint)
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

	// The snapshot exists; AbortBackup would now destroy it.
	snapshotSetStarted = false

	// Collect writer statuses (best-effort — don't fail the snapshot on this).
	writers := p.collectWriterStatuses(ctx, backupComponents)

	// GetSnapshotProperties for each volume.
	shadowPaths := make(map[string]string, len(entries))
	var sessionID string
	var warnings []string

	for _, entry := range entries {
		deviceName, err := p.getSnapshotDeviceName(backupComponents, entry.snapID)
		if err != nil {
			warnMsg := fmt.Sprintf("GetSnapshotProperties failed for volume %s: %s", entry.volume, err.Error())
			slog.Warn("vss: " + warnMsg)
			warnings = append(warnings, warnMsg)
			continue
		}
		shadowPaths[entry.volume] = deviceName
		if sessionID == "" {
			sessionID = guidToString(entry.snapID)
		}
	}

	// A snapshot set with no usable device paths is not a usable snapshot —
	// returning it would make the caller rewrite nothing and silently read the
	// live volume while reporting a VSS-backed backup.
	if len(shadowPaths) == 0 {
		return nil, fmt.Errorf("vss: no shadow copy device paths resolved for %d volume(s)", len(entries))
	}

	// Free writer metadata now that the snapshot is complete.
	callVtable(backupComponents, vtblFreeWriterMetadata) //nolint:errcheck

	session := &VSSSession{
		ID:          sessionID,
		Volumes:     volumes,
		ShadowPaths: shadowPaths,
		Writers:     writers,
		Warnings:    warnings,
		CreatedAt:   time.Now().UTC(),
	}

	slog.Info("vss: shadow copy created",
		"sessionId", sessionID,
		"volumes", len(volumes),
		"shadowPaths", len(shadowPaths),
		"durationMs", time.Since(start).Milliseconds(),
	)

	return session, nil
}

// ---------------------------------------------------------------------------
// ReleaseShadowCopy
// ---------------------------------------------------------------------------

// ReleaseShadowCopy is best-effort cleanup. The shadow copies created by
// CreateShadowCopy are non-persistent VSS_CTX_BACKUP copies owned by the
// IVssBackupComponents instance that made them, and that instance is already
// released by the time this runs; Windows reclaims the copies when the
// breeze-backup process exits. This call therefore exists to log the release
// point, not to delete anything.
func (p *WindowsProvider) ReleaseShadowCopy(session *VSSSession) error {
	if session == nil {
		return nil
	}

	p.mu.Lock()
	defer p.mu.Unlock()

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
		if hr, ok := err.(*ole.OleError); !ok || hr.Code() != sFalse {
			return nil, fmt.Errorf("vss: CoInitializeEx failed: %w", err)
		}
	}
	defer ole.CoUninitialize()

	var backupComponents uintptr
	hr, _, _ := procCreateVssBackupComponentsInternal.Call(uintptr(unsafe.Pointer(&backupComponents)))
	if err := checkHR(hr, "CreateVssBackupComponentsInternal"); err != nil {
		return nil, err
	}
	if backupComponents == 0 {
		return nil, fmt.Errorf("vss: CreateVssBackupComponentsInternal returned a nil interface")
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

	writers := p.collectWriterStatuses(ctx, backupComponents)
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
			callVtable(asyncPtr, vtblAsyncCancel) //nolint:errcheck
			return fmt.Errorf("vss: %s timed out: %w", label, ErrVSSTimeout)
		default:
		}

		// QueryStatus(OUT HRESULT *pHrResult, IN OUT INT *pReserved). The
		// operation's real outcome lands in pHrResult; the method's own return
		// value only reports whether the query itself worked.
		var hrStatus int32
		var reserved int32
		if _, err := callVtable(asyncPtr, vtblAsyncQueryStatus,
			uintptr(unsafe.Pointer(&hrStatus)),
			uintptr(unsafe.Pointer(&reserved))); err != nil {
			return fmt.Errorf("vss: %s QueryStatus failed: %w", label, err)
		}

		switch uint32(hrStatus) {
		case vssSAsyncPending:
			// Still running.
		case vssSAsyncFinished:
			return nil
		case vssSAsyncCancelled:
			return fmt.Errorf("vss: %s was cancelled", label)
		default:
			if hrStatus < 0 {
				return fmt.Errorf("vss: %s failed HRESULT 0x%08X", label, uint32(hrStatus))
			}
			// Any other success code means the operation is no longer pending.
			return nil
		}

		interval := pollIntervals[pollIdx]
		if pollIdx < len(pollIntervals)-1 {
			pollIdx++
		}

		select {
		case <-ctx.Done():
			callVtable(asyncPtr, vtblAsyncCancel) //nolint:errcheck
			return fmt.Errorf("vss: %s timed out: %w", label, ErrVSSTimeout)
		case <-time.After(interval):
		}
	}
}

// getSnapshotDeviceName retrieves the shadow copy device name for a snapshot GUID.
func (p *WindowsProvider) getSnapshotDeviceName(bc uintptr, snapID windows.GUID) (string, error) {
	var prop vssSnapshotProp
	// GetSnapshotProperties(IN VSS_ID SnapshotId, OUT VSS_SNAPSHOT_PROP *pProp).
	// SnapshotId is a 16-byte struct by value → passed by hidden pointer on x64.
	if _, err := callVtable(bc, vtblGetSnapshotProperties,
		uintptr(unsafe.Pointer(&snapID)),
		uintptr(unsafe.Pointer(&prop)),
	); err != nil {
		return "", fmt.Errorf("GetSnapshotProperties: %w", err)
	}
	// VSS allocates every VSS_PWSZ in prop; the caller owns them.
	defer freeSnapshotProperties(&prop)

	if prop.SnapshotDeviceObject == 0 {
		return "", fmt.Errorf("snapshot device name is nil")
	}

	return utf16PtrToString(prop.SnapshotDeviceObject), nil
}

// freeSnapshotProperties releases the strings VSS allocated inside a
// VSS_SNAPSHOT_PROP. Falls back to a no-op if the export is unavailable rather
// than crashing a backup over a memory leak.
func freeSnapshotProperties(prop *vssSnapshotProp) {
	if err := procVssFreeSnapshotProperties.Find(); err != nil {
		slog.Debug("vss: VssFreeSnapshotProperties unavailable, leaking snapshot property strings",
			"error", err.Error())
		return
	}
	procVssFreeSnapshotProperties.Call(uintptr(unsafe.Pointer(prop)))
}

// collectWriterStatuses enumerates VSS writers and their post-snapshot state.
// Failures are logged but do not abort the caller — writer telemetry is
// diagnostic, and a snapshot that exists is still worth using.
func (p *WindowsProvider) collectWriterStatuses(ctx context.Context, bc uintptr) []WriterStatus {
	// GatherWriterStatus must run before GetWriterStatus{Count,}.
	var statusAsync uintptr
	if _, err := callVtable(bc, vtblGatherWriterStatus,
		uintptr(unsafe.Pointer(&statusAsync))); err != nil {
		slog.Warn("vss: GatherWriterStatus failed", "error", err.Error())
		return nil
	}
	if err := p.waitForAsync(ctx, statusAsync, "GatherWriterStatus"); err != nil {
		slog.Warn("vss: GatherWriterStatus wait failed", "error", err.Error())
		return nil
	}
	defer callVtable(bc, vtblFreeWriterStatus) //nolint:errcheck

	var count uint32
	if _, err := callVtable(bc, vtblGetWriterStatusCount,
		uintptr(unsafe.Pointer(&count))); err != nil {
		slog.Warn("vss: GetWriterStatusCount failed", "error", err.Error())
		return nil
	}

	writers := make([]WriterStatus, 0, count)
	for i := uint32(0); i < count; i++ {
		var instanceID, writerID windows.GUID
		var namePtr uintptr
		var state uint32
		var failureHR int32

		// GetWriterStatus(UINT iWriter, VSS_ID *pidInstance, VSS_ID *pidWriter,
		//                 BSTR *pbstrWriter, VSS_WRITER_STATE *pnStatus,
		//                 HRESULT *phResultFailure)
		if _, err := callVtable(bc, vtblGetWriterStatus,
			uintptr(i),
			uintptr(unsafe.Pointer(&instanceID)),
			uintptr(unsafe.Pointer(&writerID)),
			uintptr(unsafe.Pointer(&namePtr)),
			uintptr(unsafe.Pointer(&state)),
			uintptr(unsafe.Pointer(&failureHR)),
		); err != nil {
			slog.Warn("vss: GetWriterStatus failed", "index", i, "error", err.Error())
			continue
		}

		name := utf16PtrToString(namePtr)
		if namePtr != 0 {
			procSysFreeString.Call(namePtr)
		}

		ws := WriterStatus{
			ID:    guidToString(writerID),
			Name:  name,
			State: writerStateName(state),
		}
		if failureHR < 0 {
			ws.LastError = fmt.Sprintf("HRESULT 0x%08X", uint32(failureHR))
		}
		writers = append(writers, ws)
	}
	return writers
}

// writerStateName maps a VSS_WRITER_STATE to the short vocabulary the rest of
// Breeze uses (stable / waiting / failed / unknown).
func writerStateName(state uint32) string {
	switch {
	case state == vssWsStable:
		return "stable"
	case state > vssWsStable && state < vssWsFailedAtIdentify:
		return "waiting"
	case state >= vssWsFailedAtIdentify && state <= vssWsFailedAtBackupEnd:
		return "failed"
	default:
		return "unknown"
	}
}

// utf16PtrToString reads a NUL-terminated UTF-16 string from a raw pointer that
// Go does not own.
func utf16PtrToString(p uintptr) string {
	if p == 0 {
		return ""
	}
	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(p)))
}

// volumeMountPoint normalises a volume string into the mount-point form
// AddToSnapshotSet requires: a drive letter needs its trailing backslash
// ("C:" → "C:\"), while a volume GUID path ("\\?\Volume{...}\") or an already
// well-formed mount point is passed through unchanged.
func volumeMountPoint(vol string) string {
	if vol == "" {
		return vol
	}
	if vol[len(vol)-1] == '\\' || vol[len(vol)-1] == '/' {
		return vol
	}
	return vol + `\`
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
