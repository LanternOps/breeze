// Package promptcatalog renders every string the agent shows on a device
// prompt, from one catalog in eight locales (spec §3.1 "Who renders copy",
// plan Task 3.1).
//
// catalog/*.json are byte-identical COPIES of
// packages/shared/src/promptCatalog/catalog/*.json. go:embed patterns may not
// contain ".." and this module's root is agent/, so the shared files cannot be
// embedded directly. TestEmbeddedCatalogMatchesSharedSource (and the mirror
// assertion in packages/shared/src/promptCatalog/promptCatalog.test.ts) keep
// the copies in step.
package promptcatalog

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
)

//go:embed catalog/*.json
var catalogFS embed.FS

var (
	// ErrUnknownKey: the namespace or key is not in the catalog.
	ErrUnknownKey = errors.New("promptcatalog: unknown key")
	// ErrMissingParam: the message needs a parameter the caller did not pass.
	ErrMissingParam = errors.New("promptcatalog: missing parameter")
)

type catalogFile struct {
	Namespace string                       `json:"namespace"`
	Messages  map[string]map[string]string `json:"messages"`
}

// namespace -> key -> locale -> text
type catalog map[string]map[string]map[string]string

var (
	loadOnce      sync.Once
	loaded        catalog
	loadErr       error
	rendererOwned = map[string]bool{"remaining": true, "time": true}
	placeholderRE = regexp.MustCompile(`\{([A-Za-z][A-Za-z0-9_]*)(?::[^{}]*)?\}`)
)

func parseFile(raw []byte) (string, map[string]map[string]string, error) {
	var f catalogFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return "", nil, err
	}
	if f.Namespace == "" || len(f.Messages) == 0 {
		return "", nil, fmt.Errorf("catalog file has no namespace or messages")
	}
	for key, byLocale := range f.Messages {
		if len(byLocale) != len(Locales) {
			return "", nil, fmt.Errorf("%s/%s has %d locales, want %d", f.Namespace, key, len(byLocale), len(Locales))
		}
		for _, loc := range Locales {
			if strings.TrimSpace(byLocale[string(loc)]) == "" {
				return "", nil, fmt.Errorf("%s/%s is missing %s", f.Namespace, key, loc)
			}
		}
	}
	return f.Namespace, f.Messages, nil
}

func load() (catalog, error) {
	loadOnce.Do(func() {
		entries, err := catalogFS.ReadDir("catalog")
		if err != nil {
			loadErr = err
			return
		}
		c := catalog{}
		for _, e := range entries {
			raw, err := catalogFS.ReadFile(path.Join("catalog", e.Name()))
			if err != nil {
				loadErr = err
				return
			}
			ns, msgs, err := parseFile(raw)
			if err != nil {
				loadErr = fmt.Errorf("promptcatalog: %s: %w", e.Name(), err)
				return
			}
			if want := strings.TrimSuffix(e.Name(), ".json"); ns != want {
				loadErr = fmt.Errorf("promptcatalog: %s declares namespace %q", e.Name(), ns)
				return
			}
			c[ns] = msgs
		}
		loaded = c
	})
	return loaded, loadErr
}

// placeholders returns the sorted named parameters a message needs, excluding
// the renderer-owned {remaining} and {time:<unixMs>}.
func placeholders(text string) []string {
	seen := map[string]bool{}
	for _, m := range placeholderRE.FindAllStringSubmatch(text, -1) {
		if !rendererOwned[m[1]] {
			seen[m[1]] = true
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Render returns one catalog message in loc (negotiated; anything outside the
// eight renders en). Parameters are substituted in a single pass, so a value is
// never re-read as a placeholder; {remaining} and {time:<unixMs>} pass through
// for the renderer. It errors on an unknown namespace or key (ErrUnknownKey)
// and on a missing parameter (ErrMissingParam). Mirrors renderPromptMessage.
func Render(loc Locale, ns, key string, params map[string]string) (string, error) {
	c, err := load()
	if err != nil {
		return "", err
	}
	byLocale, ok := c[ns][key]
	if !ok {
		return "", fmt.Errorf("%w: %s/%s", ErrUnknownKey, ns, key)
	}
	text, ok := byLocale[string(Negotiate(string(loc)))]
	if !ok {
		text = byLocale[string(LocaleEN)]
	}
	out, err := substitute(text, params)
	if err != nil {
		return "", fmt.Errorf("%w: %s/%s", err, ns, key)
	}
	return out, nil
}

// substitute fills {name} parameters in one pass (a value is never re-read as
// a placeholder) and leaves {remaining} / {time:<unixMs>} for the renderer.
// Mirrors substitutePromptParams.
func substitute(text string, params map[string]string) (string, error) {
	var missing string
	out := placeholderRE.ReplaceAllStringFunc(text, func(m string) string {
		name := placeholderRE.FindStringSubmatch(m)[1]
		if rendererOwned[name] {
			return m
		}
		v, ok := params[name]
		if !ok {
			if missing == "" {
				missing = name
			}
			return m
		}
		return v
	})
	if missing != "" {
		return "", fmt.Errorf("%w %q", ErrMissingParam, missing)
	}
	return out, nil
}
