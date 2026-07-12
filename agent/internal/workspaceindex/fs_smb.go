package workspaceindex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/hirochachacha/go-smb2"
)

type smbShare interface {
	ReadDir(string) ([]os.FileInfo, error)
	Lstat(string) (os.FileInfo, error)
	Umount() error
}

type smbSession interface {
	Logoff() error
}

type smbFS struct {
	share      smbShare
	session    smbSession
	conn       io.Closer
	host       string
	shareName  string
	prefix     string
	credential Credential
	closeOnce  sync.Once
	closeErr   error
}

func (s *smbFS) ReadDir(name string) ([]fs.DirEntry, error) {
	sharePath, err := s.resolve(name)
	if err != nil {
		return nil, s.redactError("readdir", name, err)
	}
	infos, err := s.share.ReadDir(sharePath)
	if err != nil {
		return nil, s.redactError("readdir", sharePath, err)
	}
	entries := make([]fs.DirEntry, len(infos))
	for i, info := range infos {
		entries[i] = smbDirEntry{info: info}
	}
	return entries, nil
}

func (s *smbFS) Stat(name string) (fs.FileInfo, error) {
	sharePath, err := s.resolve(name)
	if err != nil {
		return nil, s.redactError("lstat", name, err)
	}
	info, err := s.share.Lstat(sharePath)
	if err != nil {
		return nil, s.redactError("lstat", sharePath, err)
	}
	return info, nil
}

// Close releases the mounted share, SMB session, and TCP connection. It
// best-effort zeroes only the credential copy retained by this filesystem;
// callers remain responsible for zeroing their own Credential value.
func (s *smbFS) Close() error {
	s.closeOnce.Do(func() {
		defer s.credential.Zero()
		var cleanupErrors []error
		if s.share != nil {
			cleanupErrors = append(cleanupErrors, s.share.Umount())
		}
		if s.session != nil {
			cleanupErrors = append(cleanupErrors, s.session.Logoff())
		}
		if s.conn != nil {
			cleanupErrors = append(cleanupErrors, s.conn.Close())
		}
		s.closeErr = errors.Join(cleanupErrors...)
		if s.closeErr != nil {
			s.closeErr = s.redactError("close", "", s.closeErr)
		}
	})
	return s.closeErr
}

func (s *smbFS) resolve(name string) (string, error) {
	normalized := strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(normalized, "/") {
		return "", &fs.PathError{Op: "resolve", Path: name, Err: fs.ErrInvalid}
	}
	var parts []string
	if s.prefix != "" {
		parts = append(parts, strings.Split(s.prefix, `\`)...)
	}
	if normalized != "" && normalized != "." {
		for _, part := range strings.Split(normalized, "/") {
			if part == ".." {
				return "", &fs.PathError{Op: "resolve", Path: name, Err: fs.ErrInvalid}
			}
			if part != "" && part != "." {
				parts = append(parts, part)
			}
		}
	}
	return strings.Join(parts, `\`), nil
}

func (s *smbFS) redactError(operation, path string, err error) error {
	if err == nil {
		return nil
	}
	location := strings.Trim(strings.Join([]string{s.host, s.shareName, path}, "/"), "/")
	message := fmt.Sprintf("SMB %s %s: %s", operation, location, err)
	if s.credential.Password != "" {
		message = strings.ReplaceAll(message, s.credential.Password, "[REDACTED]")
	}
	return &smbOperationError{
		message: message,
		err:     err,
	}
}

type smbOperationError struct {
	message string
	err     error
}

func (e *smbOperationError) Error() string { return e.message }
func (e *smbOperationError) Unwrap() error { return e.err }

type smbDirEntry struct {
	info os.FileInfo
}

func (e smbDirEntry) Name() string               { return e.info.Name() }
func (e smbDirEntry) IsDir() bool                { return e.info.IsDir() }
func (e smbDirEntry) Type() fs.FileMode          { return e.info.Mode().Type() }
func (e smbDirEntry) Info() (fs.FileInfo, error) { return e.info, nil }

// DialSMB connects to a UNC share using explicit NTLM credentials. The
// returned filesystem is rooted at the UNC prefix and is read-only by
// convention; the provisioned SMB account must enforce read-only access.
// Closing clears the filesystem's retained credential copy; the caller remains
// responsible for calling Zero on its own Credential value.
func DialSMB(ctx context.Context, unc string, cred *Credential) (SourceFS, io.Closer, error) {
	host, shareName, prefix, err := ParseUNC(unc)
	if err != nil {
		return nil, nil, err
	}
	if cred == nil {
		return nil, nil, fmt.Errorf("dial SMB %s/%s: credential is required", host, shareName)
	}

	credentialCopy := cloneCredential(cred)
	redactor := &smbFS{host: host, shareName: shareName, credential: credentialCopy}
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", net.JoinHostPort(host, "445"))
	if err != nil {
		credentialCopy.Zero()
		return nil, nil, redactor.dialFailure("dial", err)
	}

	domain := ""
	if credentialCopy.Domain != nil {
		domain = *credentialCopy.Domain
	}
	initiator := &smb2.NTLMInitiator{
		User:     credentialCopy.Username,
		Password: credentialCopy.Password,
		Domain:   domain,
	}
	defer func() {
		initiator.User = ""
		initiator.Password = ""
		initiator.Domain = ""
	}()

	session, err := (&smb2.Dialer{Initiator: initiator}).DialContext(dialCtx, conn)
	if err != nil {
		_ = conn.Close()
		credentialCopy.Zero()
		return nil, nil, redactor.dialFailure("authenticate", err)
	}
	share, err := session.WithContext(dialCtx).Mount(shareName)
	if err != nil {
		_ = session.Logoff()
		_ = conn.Close()
		credentialCopy.Zero()
		return nil, nil, redactor.dialFailure("mount", err)
	}

	fys := &smbFS{
		share:      share,
		session:    session,
		conn:       conn,
		host:       host,
		shareName:  shareName,
		prefix:     prefix,
		credential: credentialCopy,
	}
	redactor.credential.Zero()
	return fys, fys, nil
}

func (s *smbFS) dialFailure(operation string, err error) error {
	redacted := s.redactError(operation, "", err)
	s.credential.Zero()
	return redacted
}

func cloneCredential(cred *Credential) Credential {
	clone := Credential{Username: cred.Username, Password: cred.Password}
	if cred.Domain != nil {
		domain := *cred.Domain
		clone.Domain = &domain
	}
	return clone
}

// ParseUNC splits a UNC path into its host, share, and optional path prefix.
func ParseUNC(unc string) (host, share, prefix string, err error) {
	if !strings.HasPrefix(unc, `\\`) {
		return "", "", "", fmt.Errorf("invalid UNC path: missing leading \\\\")
	}
	if strings.Contains(unc, "/") {
		return "", "", "", fmt.Errorf("invalid UNC path: forward slashes are not allowed")
	}

	parts := strings.Split(strings.TrimPrefix(unc, `\\`), `\`)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", "", fmt.Errorf("invalid UNC path: host and share are required")
	}
	for _, part := range parts {
		if part == ".." {
			return "", "", "", fmt.Errorf("invalid UNC path: parent segments are not allowed")
		}
	}

	host, share = parts[0], parts[1]
	prefixParts := parts[2:]
	for len(prefixParts) > 0 && prefixParts[len(prefixParts)-1] == "" {
		prefixParts = prefixParts[:len(prefixParts)-1]
	}
	for _, part := range prefixParts {
		if part == "" {
			return "", "", "", fmt.Errorf("invalid UNC path: empty path segment")
		}
	}
	return host, share, strings.Join(prefixParts, `\`), nil
}
