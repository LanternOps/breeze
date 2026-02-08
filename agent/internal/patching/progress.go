package patching

// ProgressCallback receives download/install progress updates.
type ProgressCallback func(event ProgressEvent)

// ProgressEvent describes the current state of a download or install operation.
type ProgressEvent struct {
	Phase       string  `json:"phase"`       // "downloading", "installing", "verifying"
	PatchID     string  `json:"patchId"`
	PatchTitle  string  `json:"patchTitle,omitempty"`
	Percent     float64 `json:"percent"`     // 0-100
	BytesTotal  int64   `json:"bytesTotal"`
	BytesDone   int64   `json:"bytesDone"`
	CurrentItem int     `json:"currentItem"` // which patch in the batch (1-based)
	TotalItems  int     `json:"totalItems"`
	Message     string  `json:"message,omitempty"`
}

// DownloadResult captures the outcome of a patch download.
type DownloadResult struct {
	PatchID    string
	Success    bool
	Message    string
	ResultCode int
}

// DownloadableProvider extends PatchProvider with download and progress capabilities.
type DownloadableProvider interface {
	PatchProvider
	Download(patchIDs []string, progress ProgressCallback) ([]DownloadResult, error)
	InstallWithProgress(patchID string, progress ProgressCallback) (InstallResult, error)
}
