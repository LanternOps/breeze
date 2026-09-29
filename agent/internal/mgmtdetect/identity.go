package mgmtdetect

// CollectIdentityStatus reuses the existing platform detector without running
// management-product discovery. Callers must inspect Source for failed detection.
func CollectIdentityStatus() IdentityStatus { return collectIdentityStatus() }
