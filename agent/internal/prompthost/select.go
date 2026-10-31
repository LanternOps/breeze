package prompthost

import (
	"github.com/breeze-rmm/agent/internal/ipc"
)

// Path is how one prompt reaches one owner's session.
type Path int

const (
	PathNone     Path = iota // no renderer; the kind's no-renderer rule applies
	PathPrompt               // prompt_* to a renderer that advertised the kind
	PathLegacy               // today's message type (Prompt.Legacy)
	PathHeadless             // Linux daemon-drawn fallback (Prompt.Headless)
)

func (p Path) String() string {
	switch p {
	case PathPrompt:
		return "prompt"
	case PathLegacy:
		return "legacy"
	case PathHeadless:
		return "headless"
	}
	return "none"
}

// Choice is the selected path for one owner.
type Choice struct {
	Path     Path
	Renderer RendererSession
	Version  int
}

// EnabledKinds is the server kill switch (heartbeat promptHost.enabledKinds):
// a bare kind enables every version, "kind@n" one version.
type EnabledKinds struct {
	all      map[string]bool
	versions map[string]map[int]bool
}

func parseEnabledKinds(entries []string) EnabledKinds {
	e := EnabledKinds{all: map[string]bool{}, versions: map[string]map[int]bool{}}
	for _, entry := range entries {
		if name, v, ok := ipc.ParsePromptKindAd(entry); ok {
			if _, known := ipc.PromptKindClass(name); known {
				if e.versions[name] == nil {
					e.versions[name] = map[int]bool{}
				}
				e.versions[name][v] = true
			}
			continue
		}
		if _, known := ipc.PromptKindClass(entry); known {
			e.all[entry] = true
		}
	}
	return e
}

func (e EnabledKinds) allows(kind string, version int) bool {
	return e.all[kind] || e.versions[kind][version]
}

// negotiateVersion returns the highest version the agent speaks, the
// renderer advertised and the server enables (mirrors
// negotiatePromptKindVersion in packages/shared/src/promptHost/kinds.ts).
func negotiateVersion(kind string, agent []int, r RendererSession, enabled EnabledKinds) (int, bool) {
	if r.Protocol < 1 {
		return 0, false
	}
	advertised := map[int]bool{}
	for _, ad := range r.KindAds {
		if name, v, ok := ipc.ParsePromptKindAd(ad); ok && name == kind {
			advertised[v] = true
		}
	}
	best := 0
	for _, v := range agent {
		if advertised[v] && enabled.allows(kind, v) && v > best {
			best = v
		}
	}
	return best, best > 0
}

// nativeRoleFor is the native renderer role for a kind: the SYSTEM helper
// draws elevation (it owns the input-desktop window), the user-helper the rest.
func nativeRoleFor(kind string) ipc.HelperRole {
	if kind == "elevation.request" {
		return ipc.HelperRoleSystem
	}
	return ipc.HelperRoleUser
}

// selectRenderer picks exactly one path for one owner (spec §3.1 "Choosing a
// renderer"): Assist holding the kind, then the native helper holding it,
// then the legacy type, then headless, then none. Only a live renderer that
// advertised the kind at a version the agent speaks and the server enables
// is ever chosen for prompt_*; an old renderer that advertised nothing is
// skipped, so the domain's legacy sender handles it exactly as today.
// exclude lists renderer keys that already failed this prompt.
func selectRenderer(kind string, agent []int, renderers []RendererSession, enabled EnabledKinds, exclude map[string]bool, hasLegacy, hasHeadless bool) Choice {
	return selectRendererVia(kind, agent, nil, renderers, enabled, exclude, hasLegacy, hasHeadless)
}

// rolesFor is the renderer roles a prompt may use, in preference order: the
// prompt's own Roles, else Assist then the kind's native role.
func rolesFor(kind string, roles []ipc.HelperRole) []ipc.HelperRole {
	if roles != nil {
		return roles
	}
	return []ipc.HelperRole{ipc.HelperRoleAssist, nativeRoleFor(kind)}
}

// selectRendererVia is selectRenderer restricted to roles (nil = default).
func selectRendererVia(kind string, agent []int, roles []ipc.HelperRole, renderers []RendererSession, enabled EnabledKinds, exclude map[string]bool, hasLegacy, hasHeadless bool) Choice {
	if _, known := ipc.PromptKindClass(kind); known {
		for _, role := range rolesFor(kind, roles) {
			var best Choice
			found := false
			for _, r := range renderers {
				if r.Role != role || exclude[r.Key] {
					continue
				}
				v, ok := negotiateVersion(kind, agent, r, enabled)
				if !ok {
					continue
				}
				// Several renderers of one role in a session (an update in
				// flight): the newest connection wins.
				if !found || r.ConnectedAt.After(best.Renderer.ConnectedAt) {
					best = Choice{Path: PathPrompt, Renderer: r, Version: v}
					found = true
				}
			}
			if found {
				return best
			}
		}
	}
	switch {
	case hasLegacy:
		return Choice{Path: PathLegacy}
	case hasHeadless:
		return Choice{Path: PathHeadless}
	}
	return Choice{Path: PathNone}
}
