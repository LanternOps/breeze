//go:build windows

package patching

import (
	"fmt"
	"runtime"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
	"go.uber.org/zap"
)

// WindowsUpdateProvider integrates with Windows Update.
type WindowsUpdateProvider struct {
	logger *zap.Logger
}

// NewWindowsUpdateProvider creates a new WindowsUpdateProvider.
func NewWindowsUpdateProvider(logger *zap.Logger) *WindowsUpdateProvider {
	return &WindowsUpdateProvider{logger: logger}
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

		installer, err := w.createInstaller(session, update)
		if err != nil {
			return err
		}
		defer installer.Release()

		installResultVar, err := oleutil.CallMethod(installer, "Install")
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
		if resultCode != 2 && resultCode != 3 {
			return fmt.Errorf("install failed with result code %d", resultCode)
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
				ID:      update.ID,
				Title:   update.Title,
				Version: update.Version,
			})
		}

		return nil
	})
}

func (w *WindowsUpdateProvider) withSession(action func(session *ole.IDispatch) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

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

	return AvailablePatch{
		ID:          updateID,
		Title:       title,
		Description: description,
	}, nil
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
