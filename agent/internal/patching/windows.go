//go:build windows

package patching

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("patching")

// WindowsUpdateProvider integrates with Windows Update.
type WindowsUpdateProvider struct {
	cfg *config.Config
}

// NewWindowsUpdateProvider creates a new WindowsUpdateProvider.
func NewWindowsUpdateProvider(cfg *config.Config) *WindowsUpdateProvider {
	return &WindowsUpdateProvider{cfg: cfg}
}

// ID returns the provider identifier.
func (w *WindowsUpdateProvider) ID() string {
	return "windows-update"
}

// Name returns the human-readable provider name.
func (w *WindowsUpdateProvider) Name() string {
	return "Windows Update"
}

// Scan returns available Windows Updates.
func (w *WindowsUpdateProvider) Scan() ([]AvailablePatch, error) {
	var patches []AvailablePatch
	return patches, w.withSession(func(session *ole.IDispatch) error {
		updates, err := w.searchUpdates(session, "IsInstalled=0")
		if err != nil {
			return err
		}

		patches = updates
		return nil
	})
}

// Install installs a Windows Update by update ID.
func (w *WindowsUpdateProvider) Install(patchID string) (InstallResult, error) {
	var result InstallResult
	result.PatchID = patchID

	err := w.withSession(func(session *ole.IDispatch) error {
		update, err := w.findUpdate(session, "IsInstalled=0", patchID)
		if err != nil {
			return err
		}
		defer update.Release()

		// Auto-accept EULA if configured
		if err := w.acceptEulaIfNeeded(update); err != nil {
			log.Warn("EULA acceptance failed", "patchId", patchID, "error", err)
		}

		// Create restore point before install (best-effort, skip for definitions)
		category := w.mapCategory(update)
		if category != "definitions" {
			title, _ := w.getStringProperty(update, "Title")
			if rpErr := CreateRestorePoint("Before install: " + title); rpErr != nil {
				log.Debug("restore point creation failed (non-fatal)", "error", rpErr)
			}
		}

		installer, err := w.createInstaller(session, update)
		if err != nil {
			return err
		}
		defer installer.Release()

		installResultVar, err := w.callWithRetry("Install", func() (*ole.VARIANT, error) {
			return oleutil.CallMethod(installer, "Install")
		})
		if err != nil {
			return fmt.Errorf("install failed: %w", err)
		}
		defer installResultVar.Clear()

		installResult := installResultVar.ToIDispatch()
		if installResult == nil {
			return fmt.Errorf("install failed: missing result")
		}
		defer installResult.Release()

		rebootRequired, _ := w.getBoolProperty(installResult, "RebootRequired")
		result.RebootRequired = rebootRequired

		resultCode, _ := w.getIntProperty(installResult, "ResultCode")
		result.ResultCode = resultCode

		// Capture per-update HResult
		updateResultVar, urErr := oleutil.CallMethod(installResult, "GetUpdateResult", 0)
		if urErr == nil {
			updateResult := updateResultVar.ToIDispatch()
			updateResultVar.Clear()
			if updateResult != nil {
				hresult, _ := w.getIntProperty(updateResult, "HResult")
				result.HResult = hresult
				updateResult.Release()
				if hresult != 0 {
					result.Message = FormatHResult(hresult)
				}
			}
		}

		if resultCode != 2 && resultCode != 3 {
			msg := fmt.Sprintf("install failed with result code %d", resultCode)
			if result.HResult != 0 {
				msg += ": " + FormatHResult(result.HResult)
			}
			return fmt.Errorf("%s", msg)
		}

		// Post-install verification: re-search to confirm installation
		if resultCode == 2 || resultCode == 3 {
			verifyUpdate, verifyErr := w.findUpdate(session, "IsInstalled=0", patchID)
			if verifyErr == nil && verifyUpdate != nil {
				// Still shows as not installed — likely needs reboot
				verifyUpdate.Release()
				if !result.RebootRequired {
					result.RebootRequired = true
				}
				result.Message = "installed but not verified — reboot may be required"
				log.Info("post-install verify: update still pending", "patchId", patchID)
			}
		}

		return nil
	})

	if err != nil {
		return InstallResult{}, err
	}

	return result, nil
}

// Uninstall removes a Windows Update by update ID.
func (w *WindowsUpdateProvider) Uninstall(patchID string) error {
	return w.withSession(func(session *ole.IDispatch) error {
		update, err := w.findUpdate(session, "IsInstalled=1 and IsUninstallable=1", patchID)
		if err != nil {
			return err
		}
		defer update.Release()

		installer, err := w.createInstaller(session, update)
		if err != nil {
			return err
		}
		defer installer.Release()

		uninstallResultVar, err := oleutil.CallMethod(installer, "Uninstall")
		if err != nil {
			return fmt.Errorf("uninstall failed: %w", err)
		}
		defer uninstallResultVar.Clear()

		uninstallResult := uninstallResultVar.ToIDispatch()
		if uninstallResult == nil {
			return fmt.Errorf("uninstall failed: missing result")
		}
		defer uninstallResult.Release()

		resultCode, _ := w.getIntProperty(uninstallResult, "ResultCode")
		if resultCode != 2 && resultCode != 3 {
			return fmt.Errorf("uninstall failed with result code %d", resultCode)
		}

		return nil
	})
}

// GetInstalled returns installed Windows Updates.
func (w *WindowsUpdateProvider) GetInstalled() ([]InstalledPatch, error) {
	var patches []InstalledPatch
	return patches, w.withSession(func(session *ole.IDispatch) error {
		updates, err := w.searchUpdates(session, "IsInstalled=1")
		if err != nil {
			return err
		}

		for _, update := range updates {
			patches = append(patches, InstalledPatch{
				ID:       update.ID,
				Title:    update.Title,
				Version:  update.Version,
				KBNumber: update.KBNumber,
				Category: update.Category,
			})
		}

		return nil
	})
}

func (w *WindowsUpdateProvider) withSession(action func(session *ole.IDispatch) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Pre-check: ensure Windows Update service is running
	svcCheck := checkWUServiceHealth()
	if !svcCheck.Passed {
		return fmt.Errorf("WU service pre-check failed: %s", svcCheck.Message)
	}

	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		return fmt.Errorf("failed to initialize COM: %w", err)
	}
	defer ole.CoUninitialize()

	unknown, err := oleutil.CreateObject("Microsoft.Update.Session")
	if err != nil {
		return fmt.Errorf("failed to create update session: %w", err)
	}
	defer unknown.Release()

	session, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return fmt.Errorf("failed to query update session: %w", err)
	}
	defer session.Release()

	return action(session)
}

func (w *WindowsUpdateProvider) searchUpdates(session *ole.IDispatch, criteria string) ([]AvailablePatch, error) {
	searcherVar, err := oleutil.CallMethod(session, "CreateUpdateSearcher")
	if err != nil {
		return nil, fmt.Errorf("create searcher failed: %w", err)
	}
	defer searcherVar.Clear()

	searcher := searcherVar.ToIDispatch()
	if searcher == nil {
		return nil, fmt.Errorf("create searcher failed: nil searcher")
	}
	defer searcher.Release()

	resultVar, err := w.callWithRetry("Search", func() (*ole.VARIANT, error) {
		return oleutil.CallMethod(searcher, "Search", criteria)
	})
	if err != nil {
		return nil, fmt.Errorf("search failed: %w", err)
	}
	defer resultVar.Clear()

	result := resultVar.ToIDispatch()
	if result == nil {
		return nil, fmt.Errorf("search failed: nil result")
	}
	defer result.Release()

	updatesVar, err := oleutil.GetProperty(result, "Updates")
	if err != nil {
		return nil, fmt.Errorf("updates collection failed: %w", err)
	}
	defer updatesVar.Clear()

	updates := updatesVar.ToIDispatch()
	if updates == nil {
		return nil, fmt.Errorf("updates collection missing")
	}
	defer updates.Release()

	countVar, err := oleutil.GetProperty(updates, "Count")
	if err != nil {
		return nil, fmt.Errorf("updates count failed: %w", err)
	}
	defer countVar.Clear()

	count := int(countVar.Val)
	patches := make([]AvailablePatch, 0, count)

	for i := 0; i < count; i++ {
		itemVar, err := oleutil.CallMethod(updates, "Item", i)
		if err != nil {
			continue
		}
		update := itemVar.ToIDispatch()
		itemVar.Clear()
		if update == nil {
			continue
		}

		patch, err := w.updateToPatch(update)
		update.Release()
		if err != nil {
			continue
		}

		// Filter excluded update types
		if w.shouldExcludePatch(patch) {
			continue
		}

		patches = append(patches, patch)
	}

	return patches, nil
}

func (w *WindowsUpdateProvider) updateToPatch(update *ole.IDispatch) (AvailablePatch, error) {
	identityVar, err := oleutil.GetProperty(update, "Identity")
	if err != nil {
		return AvailablePatch{}, err
	}
	defer identityVar.Clear()

	identity := identityVar.ToIDispatch()
	if identity == nil {
		return AvailablePatch{}, fmt.Errorf("update identity missing")
	}
	defer identity.Release()

	updateID, err := w.getStringProperty(identity, "UpdateID")
	if err != nil {
		return AvailablePatch{}, err
	}

	title, _ := w.getStringProperty(update, "Title")
	description, _ := w.getStringProperty(update, "Description")
	severity, _ := w.getStringProperty(update, "MsrcSeverity")
	isDownloaded, _ := w.getBoolProperty(update, "IsDownloaded")
	maxSize, _ := w.getIntProperty(update, "MaxDownloadSize")
	rebootBehavior, _ := w.getIntProperty(update, "RebootBehavior")

	kbNumber := w.getKBNumber(update)
	category := w.mapCategory(update)
	eulaAccepted, _ := w.getBoolProperty(update, "EulaAccepted")

	// Determine update type: software, driver, or feature
	updateType := "software"
	typeVal, _ := w.getIntProperty(update, "Type")
	if typeVal == 2 {
		updateType = "driver"
	}
	browseOnly, _ := w.getBoolProperty(update, "BrowseOnly")
	if browseOnly {
		updateType = "feature"
	}

	if severity == "" {
		severity = "unknown"
	}

	return AvailablePatch{
		ID:             updateID,
		Title:          title,
		Description:    description,
		Severity:       strings.ToLower(severity),
		Category:       category,
		KBNumber:       kbNumber,
		Size:           int64(maxSize),
		IsDownloaded:   isDownloaded,
		RebootRequired: rebootBehavior != 0,
		UpdateType:     updateType,
		EulaAccepted:   eulaAccepted,
	}, nil
}

// getKBNumber extracts the first KB article ID from the update.
func (w *WindowsUpdateProvider) getKBNumber(update *ole.IDispatch) string {
	kbIDsVar, err := oleutil.GetProperty(update, "KBArticleIDs")
	if err != nil {
		return ""
	}
	defer kbIDsVar.Clear()

	kbIDs := kbIDsVar.ToIDispatch()
	if kbIDs == nil {
		return ""
	}
	defer kbIDs.Release()

	countVar, err := oleutil.GetProperty(kbIDs, "Count")
	if err != nil || int(countVar.Val) == 0 {
		countVar.Clear()
		return ""
	}
	countVar.Clear()

	itemVar, err := oleutil.CallMethod(kbIDs, "Item", 0)
	if err != nil {
		return ""
	}
	defer itemVar.Clear()

	kb := itemVar.ToString()
	if kb != "" && !strings.HasPrefix(kb, "KB") {
		kb = "KB" + kb
	}
	return kb
}

// mapCategory extracts and maps the first WUA category to a normalized name.
func (w *WindowsUpdateProvider) mapCategory(update *ole.IDispatch) string {
	catsVar, err := oleutil.GetProperty(update, "Categories")
	if err != nil {
		return "application"
	}
	defer catsVar.Clear()

	cats := catsVar.ToIDispatch()
	if cats == nil {
		return "application"
	}
	defer cats.Release()

	countVar, err := oleutil.GetProperty(cats, "Count")
	if err != nil || int(countVar.Val) == 0 {
		countVar.Clear()
		return "application"
	}
	countVar.Clear()

	itemVar, err := oleutil.CallMethod(cats, "Item", 0)
	if err != nil {
		return "application"
	}
	defer itemVar.Clear()

	cat := itemVar.ToIDispatch()
	if cat == nil {
		return "application"
	}
	defer cat.Release()

	name, _ := w.getStringProperty(cat, "Name")
	nameLower := strings.ToLower(name)

	switch {
	case strings.Contains(nameLower, "security") || strings.Contains(nameLower, "critical"):
		return "security"
	case strings.Contains(nameLower, "definition"):
		return "definitions"
	case strings.Contains(nameLower, "driver"):
		return "driver"
	case strings.Contains(nameLower, "feature"):
		return "feature"
	case strings.Contains(nameLower, "service pack") || strings.Contains(nameLower, "update rollup"):
		return "system"
	default:
		return "application"
	}
}

func (w *WindowsUpdateProvider) findUpdate(session *ole.IDispatch, criteria, patchID string) (*ole.IDispatch, error) {
	searcherVar, err := oleutil.CallMethod(session, "CreateUpdateSearcher")
	if err != nil {
		return nil, fmt.Errorf("create searcher failed: %w", err)
	}
	defer searcherVar.Clear()

	searcher := searcherVar.ToIDispatch()
	if searcher == nil {
		return nil, fmt.Errorf("create searcher failed: nil searcher")
	}
	defer searcher.Release()

	resultVar, err := oleutil.CallMethod(searcher, "Search", criteria)
	if err != nil {
		return nil, fmt.Errorf("search failed: %w", err)
	}
	defer resultVar.Clear()

	result := resultVar.ToIDispatch()
	if result == nil {
		return nil, fmt.Errorf("search failed: nil result")
	}
	defer result.Release()

	updatesVar, err := oleutil.GetProperty(result, "Updates")
	if err != nil {
		return nil, fmt.Errorf("updates collection failed: %w", err)
	}
	defer updatesVar.Clear()

	updates := updatesVar.ToIDispatch()
	if updates == nil {
		return nil, fmt.Errorf("updates collection missing")
	}
	defer updates.Release()

	countVar, err := oleutil.GetProperty(updates, "Count")
	if err != nil {
		return nil, fmt.Errorf("updates count failed: %w", err)
	}
	defer countVar.Clear()

	count := int(countVar.Val)
	for i := 0; i < count; i++ {
		itemVar, err := oleutil.CallMethod(updates, "Item", i)
		if err != nil {
			continue
		}

		update := itemVar.ToIDispatch()
		itemVar.Clear()
		if update == nil {
			continue
		}

		identityVar, err := oleutil.GetProperty(update, "Identity")
		if err != nil {
			update.Release()
			continue
		}

		identity := identityVar.ToIDispatch()
		identityVar.Clear()
		if identity == nil {
			update.Release()
			continue
		}

		updateID, _ := w.getStringProperty(identity, "UpdateID")
		identity.Release()

		if updateID == patchID {
			return update, nil
		}
		update.Release()
	}

	return nil, fmt.Errorf("update %s not found", patchID)
}

func (w *WindowsUpdateProvider) createInstaller(session *ole.IDispatch, update *ole.IDispatch) (*ole.IDispatch, error) {
	collectionObj, err := oleutil.CreateObject("Microsoft.Update.UpdateColl")
	if err != nil {
		return nil, fmt.Errorf("create update collection failed: %w", err)
	}
	defer collectionObj.Release()

	collection, err := collectionObj.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return nil, fmt.Errorf("update collection dispatch failed: %w", err)
	}

	_, err = oleutil.CallMethod(collection, "Add", update)
	if err != nil {
		collection.Release()
		return nil, fmt.Errorf("add update failed: %w", err)
	}

	installerVar, err := oleutil.CallMethod(session, "CreateUpdateInstaller")
	if err != nil {
		collection.Release()
		return nil, fmt.Errorf("create installer failed: %w", err)
	}
	defer installerVar.Clear()

	installer := installerVar.ToIDispatch()
	if installer == nil {
		collection.Release()
		return nil, fmt.Errorf("create installer failed: nil installer")
	}

	if _, err := oleutil.PutProperty(installer, "Updates", collection); err != nil {
		installer.Release()
		collection.Release()
		return nil, fmt.Errorf("set installer updates failed: %w", err)
	}

	collection.Release()
	return installer, nil
}

// Download pre-downloads patches by their update IDs.
// Implements DownloadableProvider.
func (w *WindowsUpdateProvider) Download(patchIDs []string, progress ProgressCallback) ([]DownloadResult, error) {
	var results []DownloadResult

	err := w.withSession(func(session *ole.IDispatch) error {
		// Build collection of updates to download
		collectionObj, err := oleutil.CreateObject("Microsoft.Update.UpdateColl")
		if err != nil {
			return fmt.Errorf("create update collection failed: %w", err)
		}
		defer collectionObj.Release()

		collection, err := collectionObj.QueryInterface(ole.IID_IDispatch)
		if err != nil {
			return fmt.Errorf("update collection dispatch failed: %w", err)
		}
		defer collection.Release()

		// Map update IDs to their info for progress reporting
		type updateInfo struct {
			id    string
			title string
			size  int64
		}
		var updateInfos []updateInfo

		for i, patchID := range patchIDs {
			if progress != nil {
				progress(ProgressEvent{
					Phase:       "searching",
					PatchID:     patchID,
					CurrentItem: i + 1,
					TotalItems:  len(patchIDs),
					Message:     fmt.Sprintf("Searching for update %s", patchID),
				})
			}

			update, err := w.findUpdate(session, "IsInstalled=0", patchID)
			if err != nil {
				results = append(results, DownloadResult{
					PatchID: patchID,
					Success: false,
					Message: fmt.Sprintf("update not found: %v", err),
				})
				continue
			}

			// Auto-accept EULA before download
			if eulaErr := w.acceptEulaIfNeeded(update); eulaErr != nil {
				log.Warn("EULA acceptance failed for download", "patchId", patchID, "error", eulaErr)
			}

			title, _ := w.getStringProperty(update, "Title")
			maxSize, _ := w.getIntProperty(update, "MaxDownloadSize")
			updateInfos = append(updateInfos, updateInfo{id: patchID, title: title, size: int64(maxSize)})

			_, err = oleutil.CallMethod(collection, "Add", update)
			update.Release()
			if err != nil {
				results = append(results, DownloadResult{
					PatchID: patchID,
					Success: false,
					Message: fmt.Sprintf("failed to add to collection: %v", err),
				})
			}
		}

		if len(updateInfos) == 0 {
			return nil
		}

		// Create downloader
		downloaderVar, err := oleutil.CallMethod(session, "CreateUpdateDownloader")
		if err != nil {
			return fmt.Errorf("create downloader failed: %w", err)
		}
		defer downloaderVar.Clear()

		downloader := downloaderVar.ToIDispatch()
		if downloader == nil {
			return fmt.Errorf("create downloader failed: nil downloader")
		}
		defer downloader.Release()

		if _, err := oleutil.PutProperty(downloader, "Updates", collection); err != nil {
			return fmt.Errorf("set downloader updates failed: %w", err)
		}

		// Report download starting
		if progress != nil {
			var totalSize int64
			for _, info := range updateInfos {
				totalSize += info.size
			}
			progress(ProgressEvent{
				Phase:      "downloading",
				TotalItems: len(updateInfos),
				BytesTotal: totalSize,
				Message:    fmt.Sprintf("Downloading %d updates", len(updateInfos)),
			})
		}

		// Synchronous download with retry for concurrent operation conflicts
		downloadResultVar, err := w.callWithRetry("Download", func() (*ole.VARIANT, error) {
			return oleutil.CallMethod(downloader, "Download")
		})
		if err != nil {
			return fmt.Errorf("download failed: %w", err)
		}
		defer downloadResultVar.Clear()

		downloadResult := downloadResultVar.ToIDispatch()
		if downloadResult == nil {
			return fmt.Errorf("download failed: nil result")
		}
		defer downloadResult.Release()

		resultCode, _ := w.getIntProperty(downloadResult, "ResultCode")

		// Check per-update results
		for i, info := range updateInfos {
			updateResultVar, err := oleutil.CallMethod(downloadResult, "GetUpdateResult", i)
			if err != nil {
				results = append(results, DownloadResult{
					PatchID: info.id,
					Success: resultCode == 2,
					Message: fmt.Sprintf("download result code: %d", resultCode),
				})
				continue
			}

			updateResult := updateResultVar.ToIDispatch()
			updateResultVar.Clear()
			if updateResult == nil {
				results = append(results, DownloadResult{
					PatchID: info.id,
					Success: false,
					Message: "missing update result",
				})
				continue
			}

			code, _ := w.getIntProperty(updateResult, "ResultCode")
			hresult, _ := w.getIntProperty(updateResult, "HResult")
			updateResult.Release()

			success := code == 2 // orcSucceeded
			msg := fmt.Sprintf("result code: %d", code)
			if hresult != 0 {
				msg = fmt.Sprintf("result code: %d, %s", code, FormatHResult(hresult))
			}

			results = append(results, DownloadResult{
				PatchID:    info.id,
				Success:    success,
				Message:    msg,
				ResultCode: code,
			})

			if progress != nil {
				pct := float64(i+1) / float64(len(updateInfos)) * 100
				progress(ProgressEvent{
					Phase:       "downloading",
					PatchID:     info.id,
					PatchTitle:  info.title,
					Percent:     pct,
					CurrentItem: i + 1,
					TotalItems:  len(updateInfos),
					Message:     fmt.Sprintf("Downloaded %s", info.title),
				})
			}
		}

		return nil
	})

	return results, err
}

// InstallWithProgress installs a patch and reports progress.
// Implements DownloadableProvider.
func (w *WindowsUpdateProvider) InstallWithProgress(patchID string, progress ProgressCallback) (InstallResult, error) {
	if progress != nil {
		progress(ProgressEvent{
			Phase:       "installing",
			PatchID:     patchID,
			Percent:     0,
			CurrentItem: 1,
			TotalItems:  1,
			Message:     fmt.Sprintf("Installing update %s", patchID),
		})
	}

	result, err := w.Install(patchID)

	if progress != nil {
		msg := "Install completed"
		if err != nil {
			msg = fmt.Sprintf("Install failed: %v", err)
		}
		progress(ProgressEvent{
			Phase:       "installing",
			PatchID:     patchID,
			Percent:     100,
			CurrentItem: 1,
			TotalItems:  1,
			Message:     msg,
		})
	}

	return result, err
}

// callWithRetry wraps a WUA COM call with retry logic for WU_E_OPERATIONINPROGRESS errors.
// Retries up to 3 times with exponential backoff (5s, 10s, 20s).
func (w *WindowsUpdateProvider) callWithRetry(operation string, fn func() (*ole.VARIANT, error)) (*ole.VARIANT, error) {
	backoffs := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second}

	result, err := fn()
	if err == nil {
		return result, nil
	}

	errStr := err.Error()
	for attempt, backoff := range backoffs {
		if !isOperationInProgressError(errStr) {
			return nil, err
		}

		log.Warn("WUA operation in progress, retrying",
			"operation", operation, "attempt", attempt+2, "backoff", backoff)
		time.Sleep(backoff)

		result, err = fn()
		if err == nil {
			return result, nil
		}
		errStr = err.Error()
	}

	return nil, fmt.Errorf("%s failed after retries: %w", operation, err)
}

// isOperationInProgressError checks if a COM error string contains WUA concurrent operation codes.
func isOperationInProgressError(errStr string) bool {
	return strings.Contains(errStr, "8024000E") || strings.Contains(errStr, "80240016")
}

// acceptEulaIfNeeded accepts the EULA for an update if auto-accept is configured.
func (w *WindowsUpdateProvider) acceptEulaIfNeeded(update *ole.IDispatch) error {
	if w.cfg == nil || !w.cfg.PatchAutoAcceptEula {
		return nil
	}

	accepted, _ := w.getBoolProperty(update, "EulaAccepted")
	if accepted {
		return nil
	}

	_, err := oleutil.CallMethod(update, "AcceptEula")
	if err != nil {
		return fmt.Errorf("AcceptEula call failed: %w", err)
	}

	return nil
}

// shouldExcludePatch returns true if the patch should be filtered out based on config.
func (w *WindowsUpdateProvider) shouldExcludePatch(patch AvailablePatch) bool {
	if w.cfg == nil {
		return false
	}

	if w.cfg.PatchExcludeDrivers && patch.UpdateType == "driver" {
		log.Debug("excluding driver update", "title", patch.Title, "id", patch.ID)
		return true
	}
	if w.cfg.PatchExcludeFeatureUpdates && patch.UpdateType == "feature" {
		log.Debug("excluding feature update", "title", patch.Title, "id", patch.ID)
		return true
	}

	return false
}

func (w *WindowsUpdateProvider) getStringProperty(dispatch *ole.IDispatch, name string) (string, error) {
	value, err := oleutil.GetProperty(dispatch, name)
	if err != nil {
		return "", err
	}
	defer value.Clear()
	return value.ToString(), nil
}

func (w *WindowsUpdateProvider) getIntProperty(dispatch *ole.IDispatch, name string) (int, error) {
	value, err := oleutil.GetProperty(dispatch, name)
	if err != nil {
		return 0, err
	}
	defer value.Clear()
	return int(value.Val), nil
}

func (w *WindowsUpdateProvider) getBoolProperty(dispatch *ole.IDispatch, name string) (bool, error) {
	value, err := oleutil.GetProperty(dispatch, name)
	if err != nil {
		return false, err
	}
	defer value.Clear()

	if value.Val == 0 {
		return false, nil
	}
	return true, nil
}
