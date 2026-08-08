//go:build windows

package vss

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
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
	vtblSetBackupSucceeded    = 20
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

// hrStatusUnwritten seeds the QueryStatus out-param so that "the callee never
// wrote anything" is distinguishable from S_OK. VSS never returns this value.
const hrStatusUnwritten int32 = -0x7FFFFFFF

// freeSnapshotPropsMissing keeps the "vssapi.dll has no VssFreeSnapshotProperties"
// warning to one line per process.
var freeSnapshotPropsMissing sync.Once

// IVssAsync QueryStatus result codes (`vss.h`).
const (
	vssSAsyncPending   uint32 = 0x00042309
	vssSAsyncFinished  uint32 = 0x0004230A
	vssSAsyncCancelled uint32 = 0x0004230B
)

// The short writer-state vocabulary the rest of Breeze uses.
const (
	writerStateStable  = "stable"
	writerStateWaiting = "waiting"
	writerStateFailed  = "failed"
	writerStateUnknown = "unknown"
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

	mu sync.Mutex
	// live is the session this provider is currently holding COM resources for,
	// nil between runs. Its presence is what makes the shadow copies survive:
	// see liveSession.
	live *liveSession
}

// liveSession is the COM state that has to outlive CreateShadowCopy.
//
// Before #3269 nothing here existed, because CreateShadowCopy released its
// IVssBackupComponents on the way out. A VSS_CTX_BACKUP shadow copy is
// auto-release, so that Release is what let the snapshot vanish mid-run
// (#3260): every field below is here so that it cannot.
type liveSession struct {
	// id is the snapshot set ID, matched against the session the caller hands
	// back to ReleaseShadowCopy.
	id string

	// thread is the pinned, COM-initialised OS thread that owns bc. Every call
	// against bc — including its final Release — must be dispatched onto it.
	thread *serialThread

	// bc is the IVssBackupComponents. It is a raw COM pointer owned by thread;
	// touching it from any other goroutine is a bug.
	bc uintptr

	createdAt time.Time

	// staleAlarm logs — and only logs — when a session has been held for
	// implausibly long. See sessionStaleAfter.
	staleAlarm *time.Timer
}

// sessionStaleAfter is how long a session may be held before it is reported as
// probably leaked. The alarm is NON-DESTRUCTIVE: it writes an ERROR and nothing
// else.
//
// It is tempting to make it force-release, and that would be a bug. There is no
// elapsed-time signal that distinguishes an abandoned session from a slow but
// perfectly healthy one: RunBackupContext has no maximum duration, a large
// dataset over a slow link can legitimately run for many hours, and wall-clock
// time keeps passing while a laptop is suspended mid-run. A timer that deleted
// the snapshot on a threshold would therefore delete live snapshots out from
// under healthy runs — which is #3260, recreated deliberately by the very change
// meant to fix it.
//
// So the backstop for a genuinely leaked session stays what it always was:
// process exit, at which point the auto-release copies are reclaimed normally.
// The gate this file serialises is snapshot *creation* only, so a leaked session
// costs one held snapshot, not the machine's ability to take further ones.
//
// A package var so tests can shrink it.
var sessionStaleAfter = 12 * time.Hour

// backupCompleteTimeout bounds the BackupComplete handshake on the release
// path. It is much shorter than the provider's snapshot budget on purpose:
// telling the writers the backup is over is best-effort cleanup, and a single
// wedged writer must not hold up the end of a run that has already succeeded.
const backupCompleteTimeout = 60 * time.Second

// NewProvider creates a WindowsProvider.
func NewProvider(config Config) Provider {
	return &WindowsProvider{config: config}
}

// ---------------------------------------------------------------------------
// CreateShadowCopy
// ---------------------------------------------------------------------------

// CreateShadowCopy creates a VSS snapshot set and KEEPS IT ALIVE until
// ReleaseShadowCopy is called.
//
// The whole requester sequence runs as a single closure on a dedicated,
// COM-initialised, permanently pinned OS thread (serialThread), and the
// IVssBackupComponents it produces stays open on that thread for the rest of the
// run. That is the #3269 fix, and the reason for all the machinery: a
// VSS_CTX_BACKUP shadow copy is an *auto-release* copy, so Windows is entitled
// to delete it as soon as the requester drops its last reference. The previous
// implementation released the interface before returning — on the strength of an
// in-code claim that reclamation only happened at process exit — and a field run
// duly lost its shadow copy ~390 seconds in, after which every remaining file
// failed with ERROR_PATH_NOT_FOUND and was recorded as a per-file fault (#3260).
//
// Dispatching the body as ONE closure rather than marshalling each COM call
// individually is also load-bearing. callVtable is //go:uintptrescapes, and its
// soundness rests on every uintptr(unsafe.Pointer(&x)) conversion appearing
// directly in a callVtable(...) argument list; per-call marshalling would have
// meant building argument values on one goroutine and consuming them on another,
// which is exactly the pattern the directive cannot protect.
func (p *WindowsProvider) CreateShadowCopy(ctx context.Context, volumes []string) (*VSSSession, error) {
	if len(volumes) == 0 {
		return nil, ErrVSSNoVolumes
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// One provider, one live session. Creating a second would strand the first
	// one's COM objects with no handle left to release them by.
	if p.live != nil {
		return nil, fmt.Errorf("%w: this provider already holds session %s",
			ErrVSSSessionInProgress, p.live.id)
	}

	start := time.Now()

	// Snapshot creation — and only creation — is serialised process-wide, since
	// the provider mutex cannot see the other ephemeral providers a concurrent
	// backup_run builds. See snapshotCreationGate for why the scope stops here
	// rather than covering the whole session.
	if snapshotCreationBusy() {
		slog.Info("vss: another run is creating a snapshot set; waiting for it before starting ours")
	}
	releaseCreationGate, err := acquireSnapshotCreation(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: waited %s for another run's snapshot creation",
			err, time.Since(start).Round(time.Second))
	}
	defer releaseCreationGate()

	// The COM work lives on this thread, and so does everything created inside
	// it. It is torn down in exactly two places: the failure path just below,
	// and ReleaseShadowCopy.
	thread, err := newSerialThread(coInitializeForVSS, ole.CoUninitialize)
	if err != nil {
		return nil, err
	}

	var (
		session          *VSSSession
		backupComponents uintptr
		createErr        error
	)
	if dispatchErr := thread.do(func() {
		session, backupComponents, createErr = p.createShadowCopyOnThread(ctx, volumes)
	}); dispatchErr != nil {
		thread.close()
		return nil, dispatchErr
	}
	if createErr != nil {
		// createShadowCopyOnThread has already released everything it made.
		thread.close()
		return nil, createErr
	}

	p.live = &liveSession{
		id:        session.ID,
		thread:    thread,
		bc:        backupComponents,
		createdAt: time.Now(),
	}
	sessionID := session.ID
	p.live.staleAlarm = time.AfterFunc(sessionStaleAfter, func() {
		p.reportStaleSession(sessionID)
	})

	slog.Info("vss: shadow copy created",
		"sessionId", session.ID,
		"volumesRequested", len(volumes),
		"volumesProtected", len(session.ShadowPaths),
		"volumesUnprotected", len(session.UnprotectedVolumes),
		"writers", len(session.Writers),
		"durationMs", time.Since(start).Milliseconds(),
	)
	return session, nil
}

// coInitializeForVSS initialises the calling thread's COM apartment. Must run on
// the serialThread.
func coInitializeForVSS() error {
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		// S_FALSE (1) means COM was already initialized on this thread — that's OK.
		if hr, ok := err.(*ole.OleError); !ok || hr.Code() != sFalse {
			return fmt.Errorf("vss: CoInitializeEx failed: %w", err)
		}
	}
	return nil
}

// createShadowCopyOnThread runs the VSS requester sequence. It MUST be called on
// the session's serialThread, which owns the COM apartment.
//
// On success it returns the session and a LIVE IVssBackupComponents whose
// ownership passes to the caller. On failure it releases everything it created
// and returns a zero components pointer, so the caller never has to decide.
func (p *WindowsProvider) createShadowCopyOnThread(ctx context.Context, volumes []string) (*VSSSession, uintptr, error) {
	backupComponents, err := createBackupComponents()
	if err != nil {
		return nil, 0, err
	}

	// Ownership transfers to the caller only when handoff is set, on the very
	// last line. Until then every return below tears the components object down
	// here. This replaced a plain `defer Release`, and the difference is the
	// entire bug: releasing on the success path is what deleted the auto-release
	// shadow copy mid-run. Releasing on the *failure* paths is still required —
	// a stranded IVssBackupComponents would hold the process-wide session slot
	// with nothing left able to free it.
	handoff := false
	metadataGathered := false
	defer func() {
		if handoff {
			return
		}
		if metadataGathered {
			callVtable(backupComponents, vtblFreeWriterMetadata) //nolint:errcheck
		}
		callVtable(backupComponents, vtblRelease) //nolint:errcheck
	}()

	slog.Info("vss: backup components created")

	// InitializeForBackup(bstrXML = NULL)
	if _, err := callVtable(backupComponents, vtblInitializeForBackup, 0); err != nil {
		return nil, 0, fmt.Errorf("vss: InitializeForBackup failed: %w", err)
	}

	// SetBackupState(bSelectComponents=false, bBackupBootableSystemState=false,
	//                backupType=VSS_BT_COPY, bPartialFileSupport=false)
	if _, err := callVtable(backupComponents, vtblSetBackupState,
		vssBoolFalse, vssBoolFalse,
		uintptr(vssBackupTypeCopy), vssBoolFalse); err != nil {
		return nil, 0, fmt.Errorf("vss: SetBackupState failed: %w", err)
	}

	// GatherWriterMetadata → IVssAsync
	var gatherAsync uintptr
	if _, err := callVtable(backupComponents, vtblGatherWriterMetadata,
		uintptr(unsafe.Pointer(&gatherAsync))); err != nil {
		return nil, 0, fmt.Errorf("vss: GatherWriterMetadata failed: %w", err)
	}
	if err := p.waitForAsync(ctx, gatherAsync, "GatherWriterMetadata"); err != nil {
		return nil, 0, err
	}
	// Freed by the handoff defer above on every failure path, and by
	// ReleaseShadowCopy on the success path. It cannot simply be freed at the
	// end of this function any more: the writer metadata belongs to the
	// components object, which now outlives the call.
	metadataGathered = true
	slog.Info("vss: writer metadata gathered")

	// StartSnapshotSet must precede AddToSnapshotSet; without it every
	// AddToSnapshotSet call fails with VSS_E_BAD_STATE.
	var snapshotSetID windows.GUID
	if _, err := callVtable(backupComponents, vtblStartSnapshotSet,
		uintptr(unsafe.Pointer(&snapshotSetID))); err != nil {
		return nil, 0, fmt.Errorf("vss: StartSnapshotSet failed: %w", err)
	}

	// Any failure from here on leaves a half-built snapshot set that the
	// writers are holding state for; tell them to stand down.
	snapshotSetStarted := true
	defer func() {
		if !snapshotSetStarted {
			return
		}
		if _, abortErr := callVtable(backupComponents, vtblAbortBackup); abortErr != nil {
			// Not cosmetic: a failed abort can leave the snapshot set in
			// progress, and the *next* backup run then fails with
			// VSS_E_SNAPSHOT_SET_IN_PROGRESS. Losing this silently would leave
			// that failure with no antecedent in the logs.
			slog.Error("vss: AbortBackup failed; the snapshot set may remain in progress "+
				"and break subsequent backup runs", "error", abortErr.Error())
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
			return nil, 0, fmt.Errorf("vss: invalid volume %q: %w", vol, err)
		}
		var snapID windows.GUID
		_, callErr := callVtable(backupComponents, vtblAddToSnapshotSet,
			uintptr(unsafe.Pointer(volUTF16)),
			uintptr(unsafe.Pointer(&guidNull)),
			uintptr(unsafe.Pointer(&snapID)),
		)
		runtime.KeepAlive(volUTF16)
		if callErr != nil {
			return nil, 0, fmt.Errorf("vss: AddToSnapshotSet(%s) failed: %w", mountPoint, callErr)
		}
		entries = append(entries, snapEntry{volume: vol, snapID: snapID})
		slog.Info("vss: volume added to snapshot set", "volume", vol, "mountPoint", mountPoint)
	}

	// PrepareForBackup → IVssAsync
	var prepareAsync uintptr
	if _, err := callVtable(backupComponents, vtblPrepareForBackup,
		uintptr(unsafe.Pointer(&prepareAsync))); err != nil {
		return nil, 0, fmt.Errorf("vss: PrepareForBackup failed: %w", err)
	}
	if err := p.waitForAsync(ctx, prepareAsync, "PrepareForBackup"); err != nil {
		return nil, 0, err
	}
	slog.Info("vss: prepare for backup completed")

	// DoSnapshotSet → IVssAsync (uses configured timeout)
	var doSnapAsync uintptr
	if _, err := callVtable(backupComponents, vtblDoSnapshotSet,
		uintptr(unsafe.Pointer(&doSnapAsync))); err != nil {
		return nil, 0, fmt.Errorf("vss: DoSnapshotSet failed: %w", err)
	}
	if err := p.waitForAsync(ctx, doSnapAsync, "DoSnapshotSet"); err != nil {
		return nil, 0, err
	}
	slog.Info("vss: snapshot set created")

	// The snapshot exists; AbortBackup would now destroy it.
	snapshotSetStarted = false

	var warnings []string

	// Collect writer statuses (best-effort — a snapshot that exists is still
	// worth using, so this never fails the run). Failure to *enumerate* is
	// recorded too: otherwise `Writers: null` in the manifest is
	// indistinguishable from a machine with no registered writers.
	writers, writerErr := p.collectWriterStatuses(ctx, backupComponents)
	if writerErr != nil {
		warnMsg := fmt.Sprintf("writer status enumeration failed (%s) — writer state for this snapshot is unknown", writerErr)
		slog.Warn("vss: " + warnMsg)
		warnings = append(warnings, warnMsg)
	}
	// A writer stuck in a failed state means the data it owns is
	// crash-inconsistent even though the snapshot itself succeeded — which is
	// the whole reason to use VSS rather than copying files. Surface it instead
	// of leaving it in a struct field nobody reads.
	for _, w := range writers {
		if w.State != writerStateFailed {
			continue
		}
		warnMsg := fmt.Sprintf("writer %q (%s) is in a failed state — data owned by this writer may be application-inconsistent", w.Name, w.ID)
		if w.LastError != "" {
			warnMsg += ": " + w.LastError
		}
		slog.Warn("vss: " + warnMsg)
		warnings = append(warnings, warnMsg)
	}

	// GetSnapshotProperties for each volume.
	shadowPaths := make(map[string]string, len(entries))
	var unprotected []string

	for _, entry := range entries {
		deviceName, err := p.getSnapshotDeviceName(backupComponents, entry.snapID)
		if err != nil {
			unprotected = append(unprotected, entry.volume)
			warnMsg := fmt.Sprintf("volume %s has no shadow copy (%s) — it will be read LIVE and in-use files may be skipped", entry.volume, err.Error())
			slog.Warn("vss: " + warnMsg)
			warnings = append(warnings, warnMsg)
			continue
		}
		shadowPaths[entry.volume] = deviceName
	}

	// A snapshot set with no usable device paths is not a usable snapshot —
	// returning it would make the caller rewrite nothing and silently read the
	// live volume while reporting a VSS-backed backup. Carry the per-volume
	// HRESULTs into the error: the caller logs only this string, so dropping
	// them leaves "VSS silently isn't working" with no diagnostic content.
	if len(shadowPaths) == 0 {
		return nil, 0, fmt.Errorf("vss: no shadow copy device paths resolved for %d volume(s): %s",
			len(entries), strings.Join(warnings, "; "))
	}

	session := &VSSSession{
		// Identify the session by the snapshot *set*, not by whichever volume
		// happened to resolve first — that varied with which volume failed.
		ID:                 guidToString(snapshotSetID),
		Volumes:            volumes,
		ShadowPaths:        shadowPaths,
		UnprotectedVolumes: unprotected,
		Writers:            writers,
		Warnings:           warnings,
		CreatedAt:          time.Now().UTC(),
	}

	// The components object — and with it the auto-release shadow copies —
	// now belongs to the caller, which parks it on the session until
	// ReleaseShadowCopy. Nothing below this line may fail.
	handoff = true
	return session, backupComponents, nil
}

// ---------------------------------------------------------------------------
// ReleaseShadowCopy
// ---------------------------------------------------------------------------

// ReleaseShadowCopy ends the session: it tells the writers the backup is over
// and then drops the last reference to the IVssBackupComponents, which is what
// lets Windows reclaim the auto-release shadow copies.
//
// This used to be a no-op, and the two things it did not do were the two halves
// of #3269. It did not signal BackupComplete, so every writer stayed parked in
// VSS_WS_WAITING_FOR_BACKUP_COMPLETE until the process exited; and there was
// nothing left to release, because CreateShadowCopy had already released the
// components object on its way out — which is what allowed the snapshot to
// disappear mid-run (#3260).
//
// Everything here is best-effort in the sense that it never fails the backup:
// the run has already finished by the time this is called, and a writer that
// will not acknowledge completion is not a reason to fail a good backup. It is
// NOT best-effort about releasing: the COM objects and the process-wide session
// slot are freed on every path, including when the handshake fails.
func (p *WindowsProvider) ReleaseShadowCopy(session *VSSSession) error {
	if session == nil {
		// A caller bug rather than a normal state — don't let it vanish.
		slog.Warn("vss: ReleaseShadowCopy called with a nil session")
		return nil
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	live := p.live
	if live == nil {
		// Releasing twice, or releasing a session this provider never created.
		// Idempotent rather than an error: RunBackupContext's deferred release
		// is the normal path, and a second call must not manufacture a failure.
		slog.Warn("vss: ReleaseShadowCopy called with no live session on this provider",
			"sessionId", session.ID)
		return nil
	}
	if live.id != session.ID {
		// A foreign session. Tearing our own down to satisfy it would be
		// strictly worse than refusing: it would delete a snapshot some other
		// run is still reading through.
		slog.Error("vss: ReleaseShadowCopy called with a session this provider does not hold; refusing to release",
			"requestedSessionId", session.ID, "liveSessionId", live.id)
		return fmt.Errorf("vss: session %s is not the live session (%s)", session.ID, live.id)
	}

	p.live = nil
	return p.teardownLocked(live)
}

// teardownLocked runs the writer handshake and releases every resource the
// session holds. The caller must hold p.mu and must already have cleared
// p.live, so that a failure here can never leave a half-released session
// reachable.
func (p *WindowsProvider) teardownLocked(live *liveSession) error {
	if live.staleAlarm != nil {
		live.staleAlarm.Stop()
	}

	var completeErr error
	if dispatchErr := live.thread.do(func() {
		completeErr = p.finishBackupOnThread(live.bc)
	}); dispatchErr != nil {
		completeErr = dispatchErr
	}

	// Closing the thread runs CoUninitialize on it and then lets it exit while
	// still locked, so the OS thread is destroyed rather than handed back to the
	// scheduler carrying our COM state. The snapshot is already gone by this
	// point: the Release inside finishBackupOnThread is what reclaims it.
	live.thread.close()

	if completeErr != nil {
		// Warned, not returned as a failure: the backup is already complete and
		// its data is already uploaded. What this costs is writer hygiene, and
		// the caller (backup.go) only logs the error anyway. Surfacing it here
		// keeps the antecedent for a later VSS_E_SNAPSHOT_SET_IN_PROGRESS.
		slog.Warn("vss: writer completion handshake failed; writers may remain in "+
			"VSS_WS_WAITING_FOR_BACKUP_COMPLETE until this process exits",
			"sessionId", live.id, "error", completeErr.Error())
	}

	slog.Info("vss: shadow copy released",
		"sessionId", live.id,
		"heldMs", time.Since(live.createdAt).Milliseconds(),
		"writersSignalled", completeErr == nil,
	)
	return nil
}

// finishBackupOnThread performs the writer-completion handshake and releases the
// components object. It MUST run on the session's serialThread.
//
// Note what is NOT called here: SetBackupSucceeded (vtblSetBackupSucceeded).
// That method marks an individual *component* as backed up, and it is only
// meaningful for a component-based backup. CreateShadowCopy calls
// SetBackupState with bSelectComponents=FALSE and never calls AddComponent, so
// this requester has no components to mark — BackupComplete alone is the
// complete handshake for a non-component backup. The constant is declared and
// ABI-pinned anyway (see vss_windows_layout_test.go) so that the day someone
// adds component selection, the slot number is already checked rather than
// guessed; guessing a slot is exactly how #2999 shipped.
func (p *WindowsProvider) finishBackupOnThread(bc uintptr) error {
	// BackupComplete → IVssAsync. This is the call that moves writers out of
	// VSS_WS_WAITING_FOR_BACKUP_COMPLETE.
	var completeAsync uintptr
	if _, err := callVtable(bc, vtblBackupComplete,
		uintptr(unsafe.Pointer(&completeAsync))); err != nil {
		// Still release below — a failed BackupComplete is not a reason to leak
		// the interface and strand the snapshot.
		callVtable(bc, vtblFreeWriterMetadata) //nolint:errcheck
		callVtable(bc, vtblRelease)            //nolint:errcheck
		return fmt.Errorf("vss: BackupComplete failed: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), backupCompleteTimeout)
	waitErr := p.waitForAsync(ctx, completeAsync, "BackupComplete")
	cancel()

	callVtable(bc, vtblFreeWriterMetadata) //nolint:errcheck
	callVtable(bc, vtblRelease)            //nolint:errcheck

	if waitErr != nil {
		return waitErr
	}
	return nil
}

// reportStaleSession is the sessionStaleAfter alarm. It REPORTS and does not
// release: see sessionStaleAfter for why forcing a release on a timer would
// reintroduce #3260. A run this old is either genuinely leaked or genuinely
// slow, and nothing here can tell which — so it makes the condition visible and
// leaves the decision to a human.
func (p *WindowsProvider) reportStaleSession(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	live := p.live
	// Re-checked under the lock: a normal release racing the timer clears
	// p.live first, and this must then say nothing at all.
	if live == nil || live.id != id {
		return
	}
	slog.Error("vss: shadow copy session has been held for an implausibly long time and may have been leaked; "+
		"it is NOT being released automatically (doing so would delete a snapshot a slow run may still be reading). "+
		"The copies will be reclaimed when this process exits",
		"sessionId", id,
		"heldMs", time.Since(live.createdAt).Milliseconds(),
		"staleAfter", sessionStaleAfter.String(),
	)
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

	backupComponents, err := createBackupComponents()
	if err != nil {
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

	writers, writerErr := p.collectWriterStatuses(ctx, backupComponents)
	callVtable(backupComponents, vtblFreeWriterMetadata) //nolint:errcheck
	if writerErr != nil {
		return nil, writerErr
	}

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
//
// //go:uintptrescapes is load-bearing, not decoration. Callers pass
// uintptr(unsafe.Pointer(&x)) for out-params, and the unsafe rules only keep
// `x` pinned when that conversion appears in the argument list of the syscall
// itself. Here the value instead travels through this function's variadic
// slice, so without the directive a stack growth inside callVtable could move
// the caller's frame and leave VSS writing into abandoned stack memory. The
// directive forces those arguments to the heap and keeps them alive for the
// duration of the call.
//
// This is only sound while every such conversion appears directly in a
// callVtable(...) argument list. Do not hoist one into a local first.
//
//go:uintptrescapes
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
			cancelAsync(asyncPtr, label)
			return fmt.Errorf("vss: %s timed out: %w", label, ErrVSSTimeout)
		default:
		}

		// QueryStatus(OUT HRESULT *pHrResult, IN OUT INT *pReserved). The
		// operation's real outcome lands in pHrResult; the method's own return
		// value only reports whether the query itself worked. pReserved must be
		// NULL (MSDN).
		//
		// Seeded with a sentinel rather than left at the zero value: 0 is S_OK,
		// so an implementation that returns success without writing pHrResult
		// would otherwise read as "finished". That is exactly what #2999 did —
		// the index pointed at Wait(), which never touches this out-param — and
		// the failure mode would be a silent success instead of a loud one.
		hrStatus := hrStatusUnwritten
		if _, err := callVtable(asyncPtr, vtblAsyncQueryStatus,
			uintptr(unsafe.Pointer(&hrStatus)), 0); err != nil {
			return fmt.Errorf("vss: %s QueryStatus failed: %w", label, err)
		}
		if hrStatus == hrStatusUnwritten {
			return fmt.Errorf("vss: %s QueryStatus reported success but wrote no status "+
				"(vtable index or argument marshalling is wrong)", label)
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
			slog.Warn("vss: async reported an unrecognised success code; treating as finished",
				"op", label, "hresult", fmt.Sprintf("0x%08X", uint32(hrStatus)))
			return nil
		}

		interval := pollIntervals[pollIdx]
		if pollIdx < len(pollIntervals)-1 {
			pollIdx++
		}

		select {
		case <-ctx.Done():
			cancelAsync(asyncPtr, label)
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
	// A non-nil pointer to an empty string is just as unusable: the caller
	// prefixes paths with this, so "" would turn C:\Users into a bogus
	// drive-relative path and the walk would silently find nothing.
	name := utf16PtrToString(prop.SnapshotDeviceObject)
	if name == "" {
		return "", fmt.Errorf("snapshot device name is empty")
	}
	return name, nil
}

// freeSnapshotProperties releases the strings VSS allocated inside a
// VSS_SNAPSHOT_PROP. Falls back to a no-op if the export is unavailable rather
// than crashing a backup over a memory leak.
func freeSnapshotProperties(prop *vssSnapshotProp) {
	if err := procVssFreeSnapshotProperties.Find(); err != nil {
		// Warn once, not per snapshot: this condition never clears, so Debug
		// would make a permanent leak invisible in production while a
		// per-volume Warn would spam. (The export is present on Server 2022 and
		// Windows 10/11; this path is for stripped or embedded images.)
		freeSnapshotPropsMissing.Do(func() {
			slog.Warn("vss: VssFreeSnapshotProperties is unavailable in vssapi.dll; "+
				"snapshot property strings will leak for the life of this process",
				"error", err.Error())
		})
		return
	}
	procVssFreeSnapshotProperties.Call(uintptr(unsafe.Pointer(prop))) //nolint:errcheck
}

// collectWriterStatuses enumerates VSS writers and their post-snapshot state.
// Failures are logged but do not abort the caller — writer telemetry is
// diagnostic, and a snapshot that exists is still worth using.
func (p *WindowsProvider) collectWriterStatuses(ctx context.Context, bc uintptr) ([]WriterStatus, error) {
	// This is diagnostic telemetry, so cap it well below the provider's snapshot
	// budget (600s by default). A hung writer must not burn the caller's whole
	// VSS window here, ahead of the device-path resolution that actually matters.
	ctx, cancel := context.WithTimeout(ctx, writerStatusTimeout)
	defer cancel()

	// GatherWriterStatus must run before GetWriterStatus{Count,}.
	var statusAsync uintptr
	if _, err := callVtable(bc, vtblGatherWriterStatus,
		uintptr(unsafe.Pointer(&statusAsync))); err != nil {
		return nil, fmt.Errorf("GatherWriterStatus: %w", err)
	}
	if err := p.waitForAsync(ctx, statusAsync, "GatherWriterStatus"); err != nil {
		return nil, err
	}
	defer callVtable(bc, vtblFreeWriterStatus) //nolint:errcheck

	var count uint32
	if _, err := callVtable(bc, vtblGetWriterStatusCount,
		uintptr(unsafe.Pointer(&count))); err != nil {
		return nil, fmt.Errorf("GetWriterStatusCount: %w", err)
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
		freeBSTR(namePtr)

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
	return writers, nil
}

// writerStatusTimeout bounds the optional writer-status gather.
const writerStatusTimeout = 30 * time.Second

// createBackupComponents constructs an IVssBackupComponents, checking that the
// export resolves first. windows.LazyProc.Call *panics* when the DLL or export
// is missing, and a panic takes the whole breeze-backup process down — whereas
// the caller is written to degrade gracefully on an error ("proceeding without
// VSS"). Hosts without a usable vssapi.dll must get the degraded path, not a
// crashed job.
func createBackupComponents() (uintptr, error) {
	if err := procCreateVssBackupComponentsInternal.Find(); err != nil {
		return 0, fmt.Errorf("vss: vssapi.dll/CreateVssBackupComponentsInternal unavailable: %w", err)
	}
	var bc uintptr
	hr, _, _ := procCreateVssBackupComponentsInternal.Call(uintptr(unsafe.Pointer(&bc)))
	if err := checkHR(hr, "CreateVssBackupComponentsInternal"); err != nil {
		return 0, err
	}
	if bc == 0 {
		return 0, fmt.Errorf("vss: CreateVssBackupComponentsInternal returned a nil interface")
	}
	return bc, nil
}

// freeBSTR releases a BSTR returned by a VSS out-param. Skips the call rather
// than panicking if oleaut32 cannot be resolved (see createBackupComponents);
// leaking a writer name beats losing the job.
func freeBSTR(bstr uintptr) {
	if bstr == 0 {
		return
	}
	if err := procSysFreeString.Find(); err != nil {
		return
	}
	procSysFreeString.Call(bstr) //nolint:errcheck
}

// cancelAsync aborts an in-flight IVssAsync after a timeout. A failed Cancel
// means the operation keeps running while we release the object out from under
// it, which is a plausible antecedent for a later
// VSS_E_SNAPSHOT_SET_IN_PROGRESS — so it gets a log line rather than a
// //nolint:errcheck.
func cancelAsync(asyncPtr uintptr, label string) {
	if _, err := callVtable(asyncPtr, vtblAsyncCancel); err != nil {
		slog.Warn("vss: cancelling a timed-out async operation failed; it may still be running",
			"op", label, "error", err.Error())
	}
}

// writerStateName maps a VSS_WRITER_STATE to the short vocabulary the rest of
// Breeze uses (stable / waiting / failed / unknown).
func writerStateName(state uint32) string {
	switch {
	case state == vssWsStable:
		return writerStateStable
	case state > vssWsStable && state < vssWsFailedAtIdentify:
		return writerStateWaiting
	case state >= vssWsFailedAtIdentify && state <= vssWsFailedAtBackupEnd:
		return writerStateFailed
	default:
		return writerStateUnknown
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
