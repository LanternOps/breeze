package workloads

import (
	"strings"
	"testing"
)

var (
	testDigestA = "sha256:" + strings.Repeat("a", 64)
	testDigestB = "sha256:" + strings.Repeat("b", 64)
)

func TestNormalizeImage(t *testing.T) {
	cases := []struct {
		in   string
		want ImageRef
	}{
		{"nginx", ImageRef{Repository: "docker.io/library/nginx", Tag: "latest"}},
		{"nginx:1.27", ImageRef{Repository: "docker.io/library/nginx", Tag: "1.27"}},
		{"user/app:1", ImageRef{Repository: "docker.io/user/app", Tag: "1"}},
		{"ghcr.io/o/r:t", ImageRef{Repository: "ghcr.io/o/r", Tag: "t"}},
		{"ghcr.io/o/r", ImageRef{Repository: "ghcr.io/o/r", Tag: "latest"}},
		{"localhost:5000/x", ImageRef{Repository: "localhost:5000/x", Tag: "latest"}},
		{"localhost/x:2", ImageRef{Repository: "localhost/x", Tag: "2"}},
		{"registry.example.com:5443/team/app:5", ImageRef{Repository: "registry.example.com:5443/team/app", Tag: "5"}},
		{"Registry.Example.COM/Team/app:v1", ImageRef{Repository: "registry.example.com/Team/app", Tag: "v1"}},
		{"docker.io/library/nginx:1", ImageRef{Repository: "docker.io/library/nginx", Tag: "1"}},
		{"docker.io/nginx", ImageRef{Repository: "docker.io/library/nginx", Tag: "latest"}},
		{"index.docker.io/user/app:3", ImageRef{Repository: "docker.io/user/app", Tag: "3"}},
		{"repo@" + testDigestA, ImageRef{Repository: "docker.io/library/repo", Digest: testDigestA, Pinned: true}},
		{"repo:tag@" + testDigestA, ImageRef{Repository: "docker.io/library/repo", Tag: "tag", Digest: testDigestA, Pinned: true}},
		{"ghcr.io/o/r@" + testDigestB, ImageRef{Repository: "ghcr.io/o/r", Digest: testDigestB, Pinned: true}},
		{"", ImageRef{}},
		{"sha256:" + strings.Repeat("c", 64), ImageRef{}},
		{strings.Repeat("c", 12), ImageRef{}},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := NormalizeImage(tc.in); got != tc.want {
				t.Fatalf("NormalizeImage(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestPickRepoDigest(t *testing.T) {
	multi := []string{
		"nginx@" + testDigestA,
		"registry.example.com/mirror/nginx@" + testDigestB,
	}
	cases := []struct {
		name, repo string
		digests    []string
		want       string
	}{
		{"hub repo", "docker.io/library/nginx", multi, testDigestA},
		{"mirror repo", "registry.example.com/mirror/nginx", multi, testDigestB},
		{"no match is a local build", "docker.io/library/myapp", multi, ""},
		{"empty list", "docker.io/library/nginx", nil, ""},
		{"empty repository", "", multi, ""},
		{"malformed digest skipped", "docker.io/library/nginx", []string{"nginx@sha256:short"}, ""},
		{"entry without digest skipped", "docker.io/library/nginx", []string{"nginx"}, ""},
		{"duplicates resolve deterministically", "docker.io/library/nginx",
			[]string{"nginx@" + testDigestB, "docker.io/library/nginx@" + testDigestA}, testDigestA},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PickRepoDigest(tc.repo, tc.digests); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
