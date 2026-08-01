//go:build windows

package vss

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The VSS COM surface is reached through raw vtable dispatch and a hand-written
// mirror of VSS_SNAPSHOT_PROP. Neither the indices nor the struct layout can be
// checked by the compiler, and getting either wrong fails silently at runtime
// rather than at build time — that is exactly how #2999 shipped. These tests
// pin the ABI facts that the implementation depends on.
//
// They do not exercise the VSS service; see vss_windows_live_test.go for that.

// TestVssSnapshotProp_Layout guards the regression behind #2999's
// GetSnapshotProperties buffer: the shipped code allocated 112 bytes for a
// struct that Windows fills 128 bytes of, overwriting 16 bytes of adjacent Go
// heap on every successful snapshot.
func TestVssSnapshotProp_Layout(t *testing.T) {
	if size := unsafe.Sizeof(vssSnapshotProp{}); size != 128 {
		t.Fatalf("VSS_SNAPSHOT_PROP must be 128 bytes on 64-bit Windows, got %d", size)
	}

	var p vssSnapshotProp
	base := uintptr(unsafe.Pointer(&p))

	cases := []struct {
		name   string
		got    uintptr
		expect uintptr
	}{
		{"m_SnapshotId", uintptr(unsafe.Pointer(&p.SnapshotID)) - base, 0},
		{"m_SnapshotSetId", uintptr(unsafe.Pointer(&p.SnapshotSetID)) - base, 16},
		{"m_lSnapshotsCount", uintptr(unsafe.Pointer(&p.SnapshotsCount)) - base, 32},
		{"m_pwszSnapshotDeviceObject", uintptr(unsafe.Pointer(&p.SnapshotDeviceObject)) - base, 40},
		{"m_pwszOriginalVolumeName", uintptr(unsafe.Pointer(&p.OriginalVolumeName)) - base, 48},
		{"m_pwszOriginatingMachine", uintptr(unsafe.Pointer(&p.OriginatingMachine)) - base, 56},
		{"m_pwszServiceMachine", uintptr(unsafe.Pointer(&p.ServiceMachine)) - base, 64},
		{"m_pwszExposedName", uintptr(unsafe.Pointer(&p.ExposedName)) - base, 72},
		{"m_pwszExposedPath", uintptr(unsafe.Pointer(&p.ExposedPath)) - base, 80},
		{"m_ProviderId", uintptr(unsafe.Pointer(&p.ProviderID)) - base, 88},
		{"m_lSnapshotAttributes", uintptr(unsafe.Pointer(&p.SnapshotAttributes)) - base, 104},
		{"m_tsCreationTimestamp", uintptr(unsafe.Pointer(&p.CreationTimestamp)) - base, 112},
		{"m_eStatus", uintptr(unsafe.Pointer(&p.Status)) - base, 120},
	}
	for _, tc := range cases {
		if tc.got != tc.expect {
			t.Errorf("%s at offset %d, want %d", tc.name, tc.got, tc.expect)
		}
	}
}

// TestVssSnapshotProp_StringFieldsAreUntraced asserts the VSS_PWSZ fields stay
// uintptr. Declaring them as *uint16 would make the Go garbage collector trace
// pointers that VSS allocated with CoTaskMemAlloc.
func TestVssSnapshotProp_StringFieldsAreUntraced(t *testing.T) {
	var p vssSnapshotProp
	// A compile-time assertion: these assignments only type-check if the
	// fields are uintptr.
	p.SnapshotDeviceObject = uintptr(0)
	p.OriginalVolumeName = uintptr(0)
	p.OriginatingMachine = uintptr(0)
	p.ServiceMachine = uintptr(0)
	p.ExposedName = uintptr(0)
	p.ExposedPath = uintptr(0)
	if p.SnapshotDeviceObject != 0 {
		t.Fatal("unreachable")
	}
}

// TestVtableIndices_MatchHeaderOrder pins each index to its position in the
// IVssBackupComponents declaration order from the Windows SDK vsbackup.h,
// counting the three IUnknown slots first. The shipped bug was
// vtblInitializeForBackup == 3 (really GetWriterComponentsCount), which
// returned E_INVALIDARG for the intended NULL BSTR.
func TestVtableIndices_MatchHeaderOrder(t *testing.T) {
	// Declaration order of IVssBackupComponents, IUnknown methods included.
	order := []string{
		"QueryInterface", "AddRef", "Release",
		"GetWriterComponentsCount", "GetWriterComponents", "InitializeForBackup",
		"SetBackupState", "InitializeForRestore", "SetRestoreState",
		"GatherWriterMetadata", "GetWriterMetadataCount", "GetWriterMetadata",
		"FreeWriterMetadata", "AddComponent", "PrepareForBackup",
		"AbortBackup", "GatherWriterStatus", "GetWriterStatusCount",
		"FreeWriterStatus", "GetWriterStatus", "SetBackupSucceeded",
		"SetBackupOptions", "SetSelectedForRestore", "SetRestoreOptions",
		"SetAdditionalRestores", "SetPreviousBackupStamp", "SaveAsXML",
		"BackupComplete", "AddAlternativeLocationMapping", "AddRestoreSubcomponent",
		"SetFileRestoreStatus", "AddNewTarget", "SetRangesFilePath",
		"PreRestore", "PostRestore", "SetContext",
		"StartSnapshotSet", "AddToSnapshotSet", "DoSnapshotSet",
		"DeleteSnapshots", "ImportSnapshots", "BreakSnapshotSet",
		"GetSnapshotProperties", "Query", "IsVolumeSupported",
		"DisableWriterClasses", "EnableWriterClasses", "DisableWriterInstances",
		"ExposeSnapshot", "RevertToSnapshot", "QueryRevertStatus",
	}
	index := make(map[string]uintptr, len(order))
	for i, name := range order {
		index[name] = uintptr(i)
	}

	used := map[string]uintptr{
		"Release":               vtblRelease,
		"InitializeForBackup":   vtblInitializeForBackup,
		"SetBackupState":        vtblSetBackupState,
		"GatherWriterMetadata":  vtblGatherWriterMetadata,
		"FreeWriterMetadata":    vtblFreeWriterMetadata,
		"PrepareForBackup":      vtblPrepareForBackup,
		"AbortBackup":           vtblAbortBackup,
		"GatherWriterStatus":    vtblGatherWriterStatus,
		"GetWriterStatusCount":  vtblGetWriterStatusCount,
		"FreeWriterStatus":      vtblFreeWriterStatus,
		"GetWriterStatus":       vtblGetWriterStatus,
		"BackupComplete":        vtblBackupComplete,
		"StartSnapshotSet":      vtblStartSnapshotSet,
		"AddToSnapshotSet":      vtblAddToSnapshotSet,
		"DoSnapshotSet":         vtblDoSnapshotSet,
		"GetSnapshotProperties": vtblGetSnapshotProperties,
	}
	for name, got := range used {
		want, ok := index[name]
		if !ok {
			t.Fatalf("%s is not in the declaration order table", name)
		}
		if got != want {
			t.Errorf("vtbl%s = %d, want %d (declaration order in vsbackup.h)", name, got, want)
		}
	}

	// The specific mis-mapping that caused #2999.
	if vtblInitializeForBackup == index["GetWriterComponentsCount"] {
		t.Error("InitializeForBackup is mapped to GetWriterComponentsCount — this is bug #2999")
	}
}

// TestAsyncVtableIndices pins IVssAsync: Cancel, Wait, QueryStatus after
// IUnknown. The shipped code had QueryStatus at 4, which is Wait — so the poll
// loop called Wait(dwMilliseconds=<pointer>) and never read a status.
func TestAsyncVtableIndices(t *testing.T) {
	if vtblAsyncCancel != 3 {
		t.Errorf("IVssAsync::Cancel = %d, want 3", vtblAsyncCancel)
	}
	if vtblAsyncWait != 4 {
		t.Errorf("IVssAsync::Wait = %d, want 4", vtblAsyncWait)
	}
	if vtblAsyncQueryStatus != 5 {
		t.Errorf("IVssAsync::QueryStatus = %d, want 5", vtblAsyncQueryStatus)
	}
}

// TestBackupTypeConstants documents that VSS_BT_FULL is 1 and VSS_BT_COPY is 5.
// The shipped code named 5 "vssBackupTypeFull".
func TestBackupTypeConstants(t *testing.T) {
	if vssBackupTypeFull != 1 {
		t.Errorf("VSS_BT_FULL = %d, want 1", vssBackupTypeFull)
	}
	if vssBackupTypeCopy != 5 {
		t.Errorf("VSS_BT_COPY = %d, want 5", vssBackupTypeCopy)
	}
}

func TestWriterStateName(t *testing.T) {
	cases := []struct {
		state uint32
		want  string
	}{
		{0, "unknown"},  // VSS_WS_UNKNOWN
		{1, "stable"},   // VSS_WS_STABLE
		{2, "waiting"},  // VSS_WS_WAITING_FOR_FREEZE
		{5, "waiting"},  // VSS_WS_WAITING_FOR_BACKUP_COMPLETE
		{6, "failed"},   // VSS_WS_FAILED_AT_IDENTIFY
		{15, "failed"},  // VSS_WS_FAILED_AT_BACKUPSHUTDOWN
		{99, "unknown"}, // out of range
	}
	for _, tc := range cases {
		if got := writerStateName(tc.state); got != tc.want {
			t.Errorf("writerStateName(%d) = %q, want %q", tc.state, got, tc.want)
		}
	}
}

// TestGuidToString keeps the session-ID formatting stable; it is persisted in
// VSSMetadata.ShadowCopyID.
func TestGuidToString(t *testing.T) {
	g := windows.GUID{
		Data1: 0x1b376d94,
		Data2: 0x3700,
		Data3: 0x4de7,
		Data4: [8]byte{0x86, 0x93, 0x98, 0x6d, 0x42, 0x3d, 0x36, 0xfc},
	}
	want := "1b376d94-3700-4de7-8693-986d423d36fc"
	if got := guidToString(g); got != want {
		t.Errorf("guidToString = %q, want %q", got, want)
	}
}

// TestUtf16PtrToString_NilIsEmpty covers the nil guard used on every VSS_PWSZ
// and BSTR read.
func TestUtf16PtrToString_NilIsEmpty(t *testing.T) {
	if got := utf16PtrToString(0); got != "" {
		t.Errorf("utf16PtrToString(0) = %q, want empty", got)
	}
	s, err := windows.UTF16PtrFromString(`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`)
	if err != nil {
		t.Fatal(err)
	}
	if got := utf16PtrToString(uintptr(unsafe.Pointer(s))); got != `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1` {
		t.Errorf("round-trip failed: %q", got)
	}
}

// TestVolumeMountPoint covers the second #2999 defect: backup.go derives
// volumes with filepath.VolumeName, which yields "C:" — and
// AddToSnapshotSet("C:") returns VSS_E_OBJECT_NOT_FOUND, verified on Server
// 2022. VSS wants a mount point.
func TestVolumeMountPoint(t *testing.T) {
	cases := []struct{ in, want string }{
		{`C:`, `C:\`},
		{`C:\`, `C:\`},
		{`D:`, `D:\`},
		{`\\?\Volume{11111111-2222-3333-4444-555555555555}\`, `\\?\Volume{11111111-2222-3333-4444-555555555555}\`},
		{`C:/`, `C:/`},
		{``, ``},
	}
	for _, tc := range cases {
		if got := volumeMountPoint(tc.in); got != tc.want {
			t.Errorf("volumeMountPoint(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestHrStatusUnwrittenSentinel pins the property the sentinel relies on: it
// must not collide with S_OK or any VSS async status, so that "QueryStatus
// wrote nothing" stays distinguishable from "finished".
func TestHrStatusUnwrittenSentinel(t *testing.T) {
	if hrStatusUnwritten >= 0 {
		t.Fatalf("sentinel must be negative so an unwritten value is never read as success, got %d", hrStatusUnwritten)
	}
	// Via a variable: uint32(<negative typed constant>) is a compile-time error.
	sentinelSigned := hrStatusUnwritten
	sentinel := uint32(sentinelSigned)
	for _, status := range []uint32{0 /* S_OK */, vssSAsyncPending, vssSAsyncFinished, vssSAsyncCancelled} {
		if sentinel == status {
			t.Errorf("sentinel collides with a real VSS status 0x%08X", status)
		}
	}
}
