package workspaceindex

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseUNC(t *testing.T) {
	tests := []struct {
		name       string
		unc        string
		wantHost   string
		wantShare  string
		wantPrefix string
		wantErr    bool
	}{
		{name: "share root", unc: `\\srv\share`, wantHost: "srv", wantShare: "share"},
		{name: "nested prefix", unc: `\\srv\share\deep\path`, wantHost: "srv", wantShare: "share", wantPrefix: `deep\path`},
		{name: "trailing separator", unc: `\\srv\share\`, wantHost: "srv", wantShare: "share"},
		{name: "missing UNC prefix", unc: `srv\share`, wantErr: true},
		{name: "missing share", unc: `\\srv`, wantErr: true},
		{name: "parent segment", unc: `\\srv\share\..\x`, wantErr: true},
		{name: "empty", unc: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host, share, prefix, err := ParseUNC(tt.unc)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParseUNC(%q) succeeded, want error", tt.unc)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseUNC(%q): %v", tt.unc, err)
			}
			if host != tt.wantHost || share != tt.wantShare || prefix != tt.wantPrefix {
				t.Fatalf("ParseUNC(%q) = (%q, %q, %q), want (%q, %q, %q)", tt.unc, host, share, prefix, tt.wantHost, tt.wantShare, tt.wantPrefix)
			}
		})
	}
}

func TestDialSMBErrorMentionsHostWithoutPassword(t *testing.T) {
	const (
		host     = "192.0.2.1"
		password = "dial-secret-password"
	)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()

	_, closer, err := DialSMB(ctx, `\\`+host+`\share`, &Credential{Username: "reader", Password: password})
	if closer != nil {
		_ = closer.Close()
		t.Fatal("DialSMB returned a closer on error")
	}
	if err == nil {
		t.Fatal("DialSMB succeeded, want error")
	}
	if !strings.Contains(err.Error(), host) {
		t.Fatalf("DialSMB error %q does not mention host %q", err, host)
	}
	if strings.Contains(err.Error(), password) {
		t.Fatalf("DialSMB error %q contains password", err)
	}
}

func TestDialSMBAlreadyCancelledReturnsPromptly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()

	_, closer, err := DialSMB(ctx, `\\192.0.2.1\share`, &Credential{Username: "reader", Password: "secret"})
	if closer != nil {
		_ = closer.Close()
		t.Fatal("DialSMB returned a closer on error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("DialSMB error = %v, want context.Canceled", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("DialSMB with cancelled context took %v, want prompt return", elapsed)
	}
}

func TestSMBFSMapsPathsAndUsesLstat(t *testing.T) {
	file := fakeSMBFileInfo{name: "report.txt", size: 42}
	directory := fakeSMBFileInfo{name: "docs", mode: fs.ModeDir}
	share := &fakeSMBShare{entries: []os.FileInfo{directory, file}, statInfo: file}
	fys := &smbFS{share: share, prefix: `deep\path`}

	entries, err := fys.ReadDir(".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if share.readDirPath != `deep\path` {
		t.Fatalf("ReadDir path = %q, want %q", share.readDirPath, `deep\path`)
	}
	if got, want := []string{entries[0].Name(), entries[1].Name()}, []string{"docs", "report.txt"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("entry names = %#v, want %#v", got, want)
	}
	if !entries[0].IsDir() || entries[1].Type() != 0 {
		t.Fatalf("entry types = (%v, %v), want directory then regular file", entries[0].Type(), entries[1].Type())
	}
	if info, infoErr := entries[1].Info(); infoErr != nil || info.Name() != "report.txt" {
		t.Fatalf("entry Info() = (%v, %v), want report.txt", info, infoErr)
	}

	info, err := fys.Stat("folder/report.txt")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Name() != "report.txt" || share.lstatPath != `deep\path\folder\report.txt` {
		t.Fatalf("Stat result/path = (%q, %q), want (%q, %q)", info.Name(), share.lstatPath, "report.txt", `deep\path\folder\report.txt`)
	}
}

func TestSMBFSReadErrorDoesNotExposePassword(t *testing.T) {
	const password = "top-secret-password"
	fys := &smbFS{
		share:      &fakeSMBShare{readDirErr: errors.New("read failed using " + password)},
		credential: Credential{Password: password},
	}

	_, err := fys.ReadDir(".")
	if err == nil {
		t.Fatal("ReadDir succeeded, want error")
	}
	if strings.Contains(err.Error(), password) {
		t.Fatalf("ReadDir error %q contains password", err)
	}
}

func TestSMBFSCloseCleansUpAndZeroesRetainedCredential(t *testing.T) {
	domain := "EXAMPLE"
	share := &fakeSMBShare{}
	session := &fakeSMBSession{}
	conn := &fakeSMBConn{}
	fys := &smbFS{
		share:      share,
		session:    session,
		conn:       conn,
		credential: Credential{Username: "reader", Password: "secret", Domain: &domain},
	}

	if err := fys.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if share.umountCalls != 1 || session.logoffCalls != 1 || conn.closeCalls != 1 {
		t.Fatalf("cleanup calls = umount %d logoff %d close %d, want all 1", share.umountCalls, session.logoffCalls, conn.closeCalls)
	}
	if fys.credential.Username != "" || fys.credential.Password != "" || fys.credential.Domain != nil {
		t.Fatalf("retained credential after Close = %#v, want zeroed", fys.credential)
	}
}

type fakeSMBShare struct {
	entries     []os.FileInfo
	statInfo    os.FileInfo
	readDirErr  error
	readDirPath string
	lstatPath   string
	umountCalls int
}

func (f *fakeSMBShare) ReadDir(name string) ([]os.FileInfo, error) {
	f.readDirPath = name
	return f.entries, f.readDirErr
}

func (f *fakeSMBShare) Lstat(name string) (os.FileInfo, error) {
	f.lstatPath = name
	return f.statInfo, nil
}

func (f *fakeSMBShare) Umount() error {
	f.umountCalls++
	return nil
}

type fakeSMBSession struct{ logoffCalls int }

func (f *fakeSMBSession) Logoff() error {
	f.logoffCalls++
	return nil
}

type fakeSMBConn struct{ closeCalls int }

func (f *fakeSMBConn) Close() error {
	f.closeCalls++
	return nil
}

type fakeSMBFileInfo struct {
	name string
	size int64
	mode fs.FileMode
}

func (f fakeSMBFileInfo) Name() string       { return f.name }
func (f fakeSMBFileInfo) Size() int64        { return f.size }
func (f fakeSMBFileInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeSMBFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeSMBFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeSMBFileInfo) Sys() any           { return nil }
