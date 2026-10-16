package workloads

import (
	"regexp"
	"sort"
	"strings"
)

// ImageRef is a container image reference split into the parts the API stores.
type ImageRef struct {
	// Repository is "registry/path" with the registry always spelled out
	// ("docker.io/library/nginx"). Empty when the reference names no repository
	// (an image id).
	Repository string
	// Tag is empty when the reference is digest-pinned without a tag, or empty.
	Tag string
	// Digest is the "sha256:..." part of a pinned reference; empty otherwise.
	Digest string
	// Pinned is true when the reference carries a digest.
	Pinned bool
}

var (
	imageIDPattern = regexp.MustCompile(`^(sha256:)?[0-9a-f]{12,64}$`)
	digestPattern  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// IsImageID reports whether ref is a bare image id rather than a name.
func IsImageID(ref string) bool { return imageIDPattern.MatchString(ref) }

// NormalizeImage splits ref the way the container engines resolve it.
//
//	nginx                -> docker.io/library/nginx : latest
//	user/app:1           -> docker.io/user/app : 1
//	ghcr.io/o/r:t        -> ghcr.io/o/r : t
//	localhost:5000/x     -> localhost:5000/x : latest
//	repo@sha256:...      -> docker.io/library/repo, no tag, pinned
//	repo:tag@sha256:...  -> docker.io/library/repo : tag, pinned
func NormalizeImage(ref string) ImageRef {
	ref = strings.TrimSpace(ref)
	if ref == "" || IsImageID(ref) {
		return ImageRef{}
	}
	name, digest := ref, ""
	if i := strings.Index(name, "@"); i >= 0 {
		name, digest = name[:i], name[i+1:]
	}
	tag := ""
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name, tag = name[:i], name[i+1:]
	}
	if name == "" {
		return ImageRef{}
	}
	registry, path := splitRegistry(name)
	if path == "" {
		return ImageRef{}
	}
	if registry == "docker.io" && !strings.Contains(path, "/") {
		path = "library/" + path
	}
	if tag == "" && digest == "" {
		tag = "latest"
	}
	return ImageRef{Repository: registry + "/" + path, Tag: tag, Digest: digest, Pinned: digest != ""}
}

// splitRegistry treats the first path component as a registry host when it
// contains a dot or a colon, or is "localhost"; otherwise the image lives on
// Docker Hub.
func splitRegistry(name string) (registry, path string) {
	i := strings.Index(name, "/")
	if i < 0 {
		return "docker.io", name
	}
	first := name[:i]
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		host := strings.ToLower(first)
		switch host {
		case "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com":
			host = "docker.io"
		}
		return host, name[i+1:]
	}
	return "docker.io", name
}

// PickRepoDigest returns the digest part of the RepoDigests entry whose
// repository equals the normalized repository, or "" when none does (a locally
// built or loaded image). Entries look like "name@sha256:<hex>". When several
// match (the same repository pulled by different manifests) the smallest digest
// is returned so repeated collections agree.
func PickRepoDigest(repository string, repoDigests []string) string {
	if repository == "" {
		return ""
	}
	var matches []string
	for _, entry := range repoDigests {
		i := strings.Index(entry, "@")
		if i < 0 {
			continue
		}
		digest := entry[i+1:]
		if !digestPattern.MatchString(digest) {
			continue
		}
		if NormalizeImage(entry[:i]).Repository == repository {
			matches = append(matches, digest)
		}
	}
	if len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	return matches[0]
}
