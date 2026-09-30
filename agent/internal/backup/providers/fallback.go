package providers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// FallbackProvider wraps multiple BackupProviders. Uploads go to the primary
// (first) provider, downloads try each in order until one succeeds, and
// deletes propagate to all providers.
type FallbackProvider struct {
	providers []BackupProvider
}

// NewFallbackProvider creates a FallbackProvider from one or more providers.
// The first provider is treated as the primary.
func NewFallbackProvider(providers ...BackupProvider) *FallbackProvider {
	return &FallbackProvider{providers: providers}
}

// BackupIdentity implements JournalIdentity by delegating to the primary
// provider — the only one uploads ever go to (see UploadContext), so it's
// the only one relevant to journal resume.
func (f *FallbackProvider) BackupIdentity() string {
	if len(f.providers) == 0 {
		return "fallback|empty"
	}
	if idp, ok := f.providers[0].(JournalIdentity); ok {
		return "fallback|" + idp.BackupIdentity()
	}
	return fmt.Sprintf("fallback|%T", f.providers[0])
}

// Upload sends the file to the FIRST (primary) provider only.
func (f *FallbackProvider) Upload(localPath, remotePath string) error {
	return f.UploadContext(context.Background(), localPath, remotePath)
}

// UploadContext sends the file to the FIRST (primary) provider only.
func (f *FallbackProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if len(f.providers) == 0 {
		return errors.New("fallback provider has no configured providers")
	}
	if uploader, ok := f.providers[0].(interface {
		UploadContext(context.Context, string, string) error
	}); ok {
		return uploader.UploadContext(ctx, localPath, remotePath)
	}
	return f.providers[0].Upload(localPath, remotePath)
}

// UploadWithDigest implements DigestUploader for the FIRST (primary)
// provider, where uploads go. When the primary cannot report a digest the
// call uploads nothing and returns ErrDigestUnavailable.
func (f *FallbackProvider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (UploadDigest, error) {
	if len(f.providers) == 0 {
		return UploadDigest{}, errors.New("fallback provider has no configured providers")
	}
	if du, ok := f.providers[0].(DigestUploader); ok {
		return du.UploadWithDigest(ctx, localPath, remotePath)
	}
	return UploadDigest{}, fmt.Errorf("%w: primary provider %T", ErrDigestUnavailable, f.providers[0])
}

// SweepStaleUploads implements StaleUploadSweeper for the primary provider,
// where uploads go; a no-op when it does not support it.
func (f *FallbackProvider) SweepStaleUploads(prefix string, olderThan time.Duration) (int, error) {
	if len(f.providers) == 0 {
		return 0, nil
	}
	if sw, ok := f.providers[0].(StaleUploadSweeper); ok {
		return sw.SweepStaleUploads(prefix, olderThan)
	}
	return 0, nil
}

// Download tries each provider in order until one succeeds.
func (f *FallbackProvider) Download(remotePath, localPath string) error {
	return f.DownloadContext(context.Background(), remotePath, localPath)
}

// DownloadContext tries each provider in order until one succeeds, passing
// ctx to every provider that supports cancellation. Once ctx is done it stops
// instead of moving on to the next provider: a cancelled or timed-out
// download is not a reason to try the secondary.
func (f *FallbackProvider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	return f.DownloadSkipping(ctx, remotePath, localPath, 0)
}

// SourceCount is the number of sources a download may be served from.
func (f *FallbackProvider) SourceCount() int { return len(f.providers) }

// DownloadOnly implements SourceSkipper: download from source idx alone.
func (f *FallbackProvider) DownloadOnly(ctx context.Context, remotePath, localPath string, idx int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if idx < 0 || idx >= len(f.providers) {
		return fmt.Errorf("fallback provider has %d sources, no source %d", len(f.providers), idx)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p := f.providers[idx]
	if d, ok := p.(ContextDownloader); ok {
		return d.DownloadContext(ctx, remotePath, localPath)
	}
	return p.Download(remotePath, localPath)
}

// DownloadSkipping implements SourceSkipper: DownloadContext over every
// source after the first skip. A restore that finds a vault copy which does
// not match the snapshot's checks calls it with skip = 1 to read the same
// object from primary storage instead.
func (f *FallbackProvider) DownloadSkipping(ctx context.Context, remotePath, localPath string, skip int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if len(f.providers) == 0 {
		return errors.New("fallback provider has no configured providers")
	}
	if skip < 0 || skip >= len(f.providers) {
		return fmt.Errorf("fallback provider has %d sources, cannot skip %d", len(f.providers), skip)
	}

	var lastErr error
	for i := skip; i < len(f.providers); i++ {
		p := f.providers[i]
		if err := ctx.Err(); err != nil {
			if lastErr != nil {
				return fmt.Errorf("download of %s stopped: %w (last provider error: %v)", remotePath, err, lastErr)
			}
			return err
		}
		var err error
		if d, ok := p.(ContextDownloader); ok {
			err = d.DownloadContext(ctx, remotePath, localPath)
		} else {
			err = p.Download(remotePath, localPath)
		}
		if err == nil {
			if i > 0 {
				slog.Info("fallback download succeeded on secondary provider",
					"providerIndex", i, "remotePath", remotePath)
			}
			return nil
		}
		lastErr = err
		slog.Debug("fallback download failed, trying next provider",
			"providerIndex", i, "error", err.Error())
	}
	return fmt.Errorf("all %d providers failed to download %s: %w",
		len(f.providers)-skip, remotePath, lastErr)
}

// List returns results from the FIRST (primary) provider.
func (f *FallbackProvider) List(prefix string) ([]string, error) {
	if len(f.providers) == 0 {
		return nil, errors.New("fallback provider has no configured providers")
	}
	return f.providers[0].List(prefix)
}

// Delete removes the file from ALL providers. Errors are collected but
// do not stop deletion from remaining providers.
func (f *FallbackProvider) Delete(remotePath string) error {
	if len(f.providers) == 0 {
		return errors.New("fallback provider has no configured providers")
	}

	var errs []error
	for i, p := range f.providers {
		if err := p.Delete(remotePath); err != nil {
			slog.Warn("fallback delete failed on provider",
				"providerIndex", i, "error", err.Error())
			errs = append(errs, fmt.Errorf("provider %d: %w", i, err))
		}
	}
	return errors.Join(errs...)
}
