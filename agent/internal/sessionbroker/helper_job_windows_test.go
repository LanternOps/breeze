//go:build windows

package sessionbroker

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type helperJobTestProcess struct {
	Handle windows.Handle
	Thread windows.Handle
	PID    uint32
	Path   string
}

func startSuspendedTestProcess(t *testing.T) *helperJobTestProcess {
	t.Helper()
	exePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := []string{exePath, "-test.run=^TestHelperJobChildProcess$", "--", "breeze-helper-job-child"}
	for i := range args {
		args[i] = windows.EscapeArg(args[i])
	}
	cmdLine, err := windows.UTF16PtrFromString(strings.Join(args, " "))
	if err != nil {
		t.Fatal(err)
	}
	si := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(
		nil,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW,
		nil,
		nil,
		&si,
		&pi,
	); err != nil {
		t.Fatal(err)
	}
	return &helperJobTestProcess{
		Handle: pi.Process,
		Thread: pi.Thread,
		PID:    pi.ProcessId,
		Path:   exePath,
	}
}

func (p *helperJobTestProcess) Close() {
	if p == nil {
		return
	}
	if p.Handle != 0 {
		_ = windows.TerminateProcess(p.Handle, 1)
	}
	if p.Thread != 0 {
		_ = windows.CloseHandle(p.Thread)
		p.Thread = 0
	}
	if p.Handle != 0 {
		_ = windows.CloseHandle(p.Handle)
		p.Handle = 0
	}
}

func resumeTestProcess(t *testing.T, thread windows.Handle) {
	t.Helper()
	if _, err := windows.ResumeThread(thread); err != nil {
		t.Fatal(err)
	}
}

func TestHelperJobChildProcess(t *testing.T) {
	if len(os.Args) == 0 || os.Args[len(os.Args)-1] != "breeze-helper-job-child" {
		return
	}
	for {
		time.Sleep(time.Hour)
	}
}

func TestClosingHelperJobTerminatesAssignedProcess(t *testing.T) {
	job, err := newHelperJob()
	if err != nil {
		t.Fatal(err)
	}
	proc := startSuspendedTestProcess(t)
	defer proc.Close()
	if err := job.Assign(proc.Handle); err != nil {
		t.Fatal(err)
	}
	resumeTestProcess(t, proc.Thread)
	if err := job.Close(); err != nil {
		t.Fatal(err)
	}
	if event, err := windows.WaitForSingleObject(proc.Handle, 5_000); err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("process survived job close: event=%d err=%v", event, err)
	}
}

func TestSpawnedHelperTerminateIsIdempotent(t *testing.T) {
	proc := startSuspendedTestProcess(t)
	defer proc.Close()
	helper := &SpawnedHelper{PID: proc.PID, Handle: proc.Handle, BinaryPath: proc.Path}
	resumeTestProcess(t, proc.Thread)
	if err := helper.Terminate(); err != nil {
		t.Fatal(err)
	}
	if err := helper.Terminate(); err != nil {
		t.Fatal(err)
	}
	if event, err := windows.WaitForSingleObject(proc.Handle, 5_000); err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("process survived Terminate: event=%d err=%v", event, err)
	}
}

func TestSpawnedHelperWaitOwnsDuplicateAcrossConcurrentClose(t *testing.T) {
	waitStarted := make(chan struct{})
	allowExit := make(chan struct{})
	var mu sync.Mutex
	var closed []windows.Handle
	helper := &SpawnedHelper{
		Handle: windows.Handle(77),
		ops: &spawnedHelperOps{
			duplicateProcessHandle: func(handle windows.Handle) (windows.Handle, error) {
				if handle != windows.Handle(77) {
					t.Errorf("duplicated handle = %d, want 77", handle)
				}
				return windows.Handle(88), nil
			},
			waitForSingleObject: func(handle windows.Handle, _ uint32) (uint32, error) {
				if handle != windows.Handle(88) {
					t.Errorf("wait handle = %d, want duplicate 88", handle)
				}
				close(waitStarted)
				<-allowExit
				return windows.WAIT_OBJECT_0, nil
			},
			getExitCodeProcess: func(handle windows.Handle, exitCode *uint32) error {
				if handle != windows.Handle(88) {
					t.Errorf("exit-code handle = %d, want duplicate 88", handle)
				}
				*exitCode = 0
				return nil
			},
			closeHandle: func(handle windows.Handle) error {
				mu.Lock()
				defer mu.Unlock()
				closed = append(closed, handle)
				return nil
			},
		},
	}
	waitDone := make(chan error, 1)
	go func() {
		_, err := helper.Wait()
		waitDone <- err
	}()
	<-waitStarted
	if err := helper.Close(); err != nil {
		t.Fatal(err)
	}
	close(allowExit)
	if err := <-waitDone; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(closed) != fmt.Sprint([]windows.Handle{77, 88}) {
		t.Fatalf("closed handles = %v, want original then duplicate", closed)
	}
}

type fakeHelperJob struct {
	mu          sync.Mutex
	assignErr   error
	assignCalls []windows.Handle
	closeCalls  int
	closed      chan struct{}
}

func (j *fakeHelperJob) Assign(process windows.Handle) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.assignCalls = append(j.assignCalls, process)
	return j.assignErr
}

func (j *fakeHelperJob) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.closeCalls++
	if j.closed != nil && j.closeCalls == 1 {
		close(j.closed)
	}
	return nil
}

func (j *fakeHelperJob) counts() (assigns, closes int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return len(j.assignCalls), j.closeCalls
}

func fakeSuspendedHelper() *suspendedHelper {
	return &suspendedHelper{
		process:    windows.Handle(101),
		thread:     windows.Handle(102),
		pid:        4100,
		binaryPath: `C:\Program Files\Breeze\breeze-user-helper.exe`,
	}
}

func TestWindowsHelperSpawnerAssignFailureTerminatesSuspendedProcess(t *testing.T) {
	assignErr := errors.New("assign failed")
	job := &fakeHelperJob{assignErr: assignErr}
	var mu sync.Mutex
	var resumed []windows.Handle
	var terminated []windows.Handle
	var closed []windows.Handle
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{
		createSuspended: func(HelperKey) (*suspendedHelper, error) {
			return fakeSuspendedHelper(), nil
		},
		resumeThread: func(handle windows.Handle) (uint32, error) {
			mu.Lock()
			defer mu.Unlock()
			resumed = append(resumed, handle)
			return 1, nil
		},
		terminateProcess: func(handle windows.Handle, _ uint32) error {
			mu.Lock()
			defer mu.Unlock()
			terminated = append(terminated, handle)
			return nil
		},
		closeHandle: func(handle windows.Handle) error {
			mu.Lock()
			defer mu.Unlock()
			closed = append(closed, handle)
			return nil
		},
	})

	process, err := spawner.Spawn(HelperKey{WindowsSessionID: 7, Role: "system"})
	if process != nil {
		t.Fatalf("process = %#v, want nil", process)
	}
	if !errors.Is(err, assignErr) || !strings.Contains(err.Error(), "assign helper to job") {
		t.Fatalf("Spawn error = %v, want wrapped assignment error", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(resumed) != 0 {
		t.Fatalf("resumed handles = %v, want none", resumed)
	}
	if fmt.Sprint(terminated) != fmt.Sprint([]windows.Handle{101}) {
		t.Fatalf("terminated handles = %v, want [101]", terminated)
	}
	if fmt.Sprint(closed) != fmt.Sprint([]windows.Handle{102, 101}) {
		t.Fatalf("closed handles = %v, want [102 101]", closed)
	}
}

func TestWindowsHelperSpawnerResumeFailureTerminatesSuspendedProcess(t *testing.T) {
	resumeErr := errors.New("resume failed")
	job := &fakeHelperJob{}
	var mu sync.Mutex
	var terminated []windows.Handle
	var closed []windows.Handle
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{
		createSuspended: func(HelperKey) (*suspendedHelper, error) {
			return fakeSuspendedHelper(), nil
		},
		resumeThread: func(windows.Handle) (uint32, error) {
			return 0, resumeErr
		},
		terminateProcess: func(handle windows.Handle, _ uint32) error {
			mu.Lock()
			defer mu.Unlock()
			terminated = append(terminated, handle)
			return nil
		},
		closeHandle: func(handle windows.Handle) error {
			mu.Lock()
			defer mu.Unlock()
			closed = append(closed, handle)
			return nil
		},
	})

	process, err := spawner.Spawn(HelperKey{WindowsSessionID: 7, Role: "user"})
	if process != nil {
		t.Fatalf("process = %#v, want nil", process)
	}
	if !errors.Is(err, resumeErr) || !strings.Contains(err.Error(), "resume helper") {
		t.Fatalf("Spawn error = %v, want wrapped resume error", err)
	}
	if assigns, _ := job.counts(); assigns != 1 {
		t.Fatalf("job assign calls = %d, want 1", assigns)
	}
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(terminated) != fmt.Sprint([]windows.Handle{101}) {
		t.Fatalf("terminated handles = %v, want [101]", terminated)
	}
	if fmt.Sprint(closed) != fmt.Sprint([]windows.Handle{102, 101}) {
		t.Fatalf("closed handles = %v, want [102 101]", closed)
	}
}

func TestWindowsHelperSpawnerSerializesSpawnThroughResumeAgainstClose(t *testing.T) {
	job := &fakeHelperJob{closed: make(chan struct{})}
	resumeStarted := make(chan struct{})
	allowResume := make(chan struct{})
	closeStarted := make(chan struct{})
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{
		createSuspended: func(HelperKey) (*suspendedHelper, error) {
			return fakeSuspendedHelper(), nil
		},
		resumeThread: func(windows.Handle) (uint32, error) {
			close(resumeStarted)
			<-allowResume
			return 1, nil
		},
		terminateProcess: windows.TerminateProcess,
		closeHandle:      func(windows.Handle) error { return nil },
		closeStarting:    func() { close(closeStarted) },
	})

	spawnDone := make(chan error, 1)
	go func() {
		_, err := spawner.Spawn(HelperKey{WindowsSessionID: 7, Role: "user"})
		spawnDone <- err
	}()
	<-resumeStarted
	closeDone := make(chan error, 1)
	go func() { closeDone <- spawner.Close() }()
	<-closeStarted
	select {
	case <-job.closed:
		t.Fatal("job closed before suspended helper was resumed")
	default:
	}
	close(allowResume)
	if err := <-spawnDone; err != nil {
		t.Fatal(err)
	}
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
	if assigns, closes := job.counts(); assigns != 1 || closes != 1 {
		t.Fatalf("job calls assign=%d close=%d, want 1 each", assigns, closes)
	}
}

func TestSpawnedHelperCloseDoesNotCloseStandaloneJob(t *testing.T) {
	job := &fakeHelperJob{}
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{})
	helper := &SpawnedHelper{
		Handle:          windows.Handle(77),
		standaloneOwner: spawner,
		ops: &spawnedHelperOps{
			closeHandle: func(windows.Handle) error { return nil },
		},
	}
	if err := helper.Close(); err != nil {
		t.Fatal(err)
	}
	if _, closes := job.counts(); closes != 0 {
		t.Fatalf("job close calls = %d, want 0; Close must only release the process handle", closes)
	}
}

func TestStandaloneHelperJobReaperRetainsJobUntilProcessExit(t *testing.T) {
	job := &fakeHelperJob{}
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{})
	waitStarted := make(chan struct{})
	allowExit := make(chan struct{})
	var closed []windows.Handle
	done := make(chan struct{})
	go func() {
		reapStandaloneHelperWithOps(windows.Handle(88), spawner, &spawnedHelperOps{
			waitForSingleObject: func(handle windows.Handle, _ uint32) (uint32, error) {
				if handle != windows.Handle(88) {
					t.Errorf("wait handle = %d, want 88", handle)
				}
				close(waitStarted)
				<-allowExit
				return windows.WAIT_OBJECT_0, nil
			},
			closeHandle: func(handle windows.Handle) error {
				closed = append(closed, handle)
				return nil
			},
		})
		close(done)
	}()
	<-waitStarted
	if _, closes := job.counts(); closes != 0 {
		t.Fatalf("job closed before process exit: close calls = %d", closes)
	}
	close(allowExit)
	<-done
	if _, closes := job.counts(); closes != 1 {
		t.Fatalf("job close calls after exit = %d, want 1", closes)
	}
	if fmt.Sprint(closed) != fmt.Sprint([]windows.Handle{88}) {
		t.Fatalf("closed wait handles = %v, want [88] exactly once", closed)
	}
}

func TestStandaloneHelperJobReaperRetriesUnconfirmedWaitResults(t *testing.T) {
	waitErr := errors.New("wait failed")
	tests := []struct {
		name         string
		firstResults []struct {
			event uint32
			err   error
		}
	}{
		{
			name: "wait error",
			firstResults: []struct {
				event uint32
				err   error
			}{
				{event: windows.WAIT_FAILED, err: waitErr},
			},
		},
		{
			name: "unexpected events",
			firstResults: []struct {
				event uint32
				err   error
			}{
				{event: uint32(windows.WAIT_TIMEOUT)},
				{event: windows.WAIT_ABANDONED},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			job := &fakeHelperJob{}
			spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{})
			waitHandle := windows.Handle(88)
			waitCalls := 0
			closeCalls := 0
			var sleeps []time.Duration
			reapStandaloneHelperWithOps(waitHandle, spawner, &spawnedHelperOps{
				waitForSingleObject: func(handle windows.Handle, timeout uint32) (uint32, error) {
					if handle != waitHandle {
						t.Fatalf("wait handle = %d, want retained handle %d", handle, waitHandle)
					}
					if timeout != windows.INFINITE {
						t.Fatalf("wait timeout = %d, want INFINITE", timeout)
					}
					call := waitCalls
					waitCalls++
					if call < len(tt.firstResults) {
						return tt.firstResults[call].event, tt.firstResults[call].err
					}
					return windows.WAIT_OBJECT_0, nil
				},
				closeHandle: func(handle windows.Handle) error {
					if handle != waitHandle {
						t.Fatalf("closed handle = %d, want %d", handle, waitHandle)
					}
					closeCalls++
					return nil
				},
				sleep: func(delay time.Duration) {
					if _, closes := job.counts(); closes != 0 {
						t.Fatalf("job closed before authoritative process exit: close calls = %d", closes)
					}
					if closeCalls != 0 {
						t.Fatalf("wait handle closed before authoritative process exit: close calls = %d", closeCalls)
					}
					sleeps = append(sleeps, delay)
				},
			})

			wantWaits := len(tt.firstResults) + 1
			if waitCalls != wantWaits {
				t.Fatalf("wait calls = %d, want %d", waitCalls, wantWaits)
			}
			if len(sleeps) != len(tt.firstResults) {
				t.Fatalf("sleep calls = %d, want %d", len(sleeps), len(tt.firstResults))
			}
			if closeCalls != 1 {
				t.Fatalf("wait handle close calls = %d, want 1", closeCalls)
			}
			if _, closes := job.counts(); closes != 1 {
				t.Fatalf("job close calls = %d, want 1", closes)
			}
		})
	}
}

func TestStandaloneHelperJobReaperBoundsRetryBackoff(t *testing.T) {
	job := &fakeHelperJob{}
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{})
	waitCalls := 0
	var sleeps []time.Duration
	reapStandaloneHelperWithOps(windows.Handle(88), spawner, &spawnedHelperOps{
		waitForSingleObject: func(windows.Handle, uint32) (uint32, error) {
			waitCalls++
			if waitCalls <= 10 {
				return windows.WAIT_FAILED, errors.New("transient wait failure")
			}
			return windows.WAIT_OBJECT_0, nil
		},
		closeHandle: func(windows.Handle) error { return nil },
		sleep: func(delay time.Duration) {
			sleeps = append(sleeps, delay)
		},
	})
	if len(sleeps) != 10 {
		t.Fatalf("sleep calls = %d, want 10", len(sleeps))
	}
	if sleeps[0] != standaloneReaperInitialBackoff {
		t.Fatalf("initial backoff = %v, want %v", sleeps[0], standaloneReaperInitialBackoff)
	}
	for i, delay := range sleeps {
		if delay > standaloneReaperMaxBackoff {
			t.Fatalf("backoff[%d] = %v, exceeds cap %v", i, delay, standaloneReaperMaxBackoff)
		}
		if i > 0 && delay < sleeps[i-1] {
			t.Fatalf("backoff decreased: %v then %v", sleeps[i-1], delay)
		}
	}
	if sleeps[len(sleeps)-1] != standaloneReaperMaxBackoff {
		t.Fatalf("final backoff = %v, want cap %v", sleeps[len(sleeps)-1], standaloneReaperMaxBackoff)
	}
}

func TestWindowsHelperSpawnerClosePreventsLaterSpawn(t *testing.T) {
	job := &fakeHelperJob{}
	createCalls := 0
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{
		createSuspended: func(HelperKey) (*suspendedHelper, error) {
			createCalls++
			return fakeSuspendedHelper(), nil
		},
	})
	if err := spawner.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := spawner.Spawn(HelperKey{WindowsSessionID: 7, Role: "system"}); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("Spawn after Close error = %v, want closed error", err)
	}
	if createCalls != 0 {
		t.Fatalf("create calls = %d, want 0", createCalls)
	}
}

func TestBuildWindowsHelperLifecycleManagerOwnsAndClosesSpawner(t *testing.T) {
	job := &fakeHelperJob{}
	spawner := newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{})
	m, err := buildWindowsHelperLifecycleManager(nil, nil, func() (*windowsHelperSpawner, error) {
		return spawner, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.spawner != spawner {
		t.Fatalf("lifecycle spawner = %T %p, want %p", m.spawner, m.spawner, spawner)
	}
	m.Stop()
	if _, closes := job.counts(); closes != 1 {
		t.Fatalf("job close calls = %d, want 1", closes)
	}
}

func TestBuildWindowsHelperLifecycleManagerJobFailureReturnsNoManager(t *testing.T) {
	wantErr := errors.New("job construction failed")
	m, err := buildWindowsHelperLifecycleManager(nil, nil, func() (*windowsHelperSpawner, error) {
		return nil, wantErr
	})
	if m != nil {
		t.Fatalf("manager = %#v, want nil", m)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
}
