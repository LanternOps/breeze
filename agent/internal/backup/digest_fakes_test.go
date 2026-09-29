package backup

import (
	"context"
	"fmt"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// The production destinations (S3, local) report upload digests themselves
// (providers.DigestUploader), so uploads reach them with the ORIGINAL source
// path. The fakes below model such providers: several of them decide what to
// do from the source path they are handed (fail this file, stall that one),
// which the staged-copy path used for digest-less providers would hide. Each
// forwards to its own UploadContext/Upload with the original path and reports
// the digest of what it "stored" — the bytes a backing mockProvider now holds
// for the key, or, for fakes that keep nothing, the source read right after.

func digestAfterUpload(ctx context.Context, upload func(context.Context, string, string) error, store *mockProvider, localPath, remotePath string) (providers.UploadDigest, error) {
	if err := upload(ctx, localPath, remotePath); err != nil {
		return providers.UploadDigest{}, err
	}
	if store != nil {
		store.mu.Lock()
		data, ok := store.files[remotePath]
		store.mu.Unlock()
		if !ok {
			return providers.UploadDigest{}, fmt.Errorf("fake provider stored nothing for %s", remotePath)
		}
		return digestBytes(data), nil
	}
	return digestLocalFile(localPath)
}

func uploadNoCtx(upload func(string, string) error) func(context.Context, string, string) error {
	return func(_ context.Context, l, r string) error { return upload(l, r) }
}

func (p *fixedErrorProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, nil, l, r)
}

func (p *expiringProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, nil, l, r)
}

func (p *dyingOnRetryProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, nil, l, r)
}

func (p *snapshotKillingProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, p.backing, l, r)
}

func (p *stallOnceProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, nil, l, r)
}

func (p *failOnceProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, nil, l, r)
}

func (p *failSubstringUploadProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, uploadNoCtx(p.Upload), p.mockProvider, l, r)
}

func (p *failAfterPartialProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, p.UploadContext, nil, l, r)
}

func (h *hookProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, uploadNoCtx(h.Upload), h.mockProvider, l, r)
}

func (p *growOnceProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	return digestAfterUpload(ctx, uploadNoCtx(p.Upload), p.mockProvider, l, r)
}
