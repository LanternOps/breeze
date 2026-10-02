package sessionbroker

// Behavioural tests for the breeze-group ensure script (#7829). The script runs
// against a fake `dscl` on PATH, so these need no macOS and no real Directory
// Services — they run in the required Linux agent job. The fake reproduces the
// one real-dscl quirk that caused #7829: reading a key the record does not have
// prints "No such key: <attr>" and still EXITS 0 (verified on macOS 26 with
// `dscl . -read /Groups/staff NoSuchAttr; echo $?`), so the exit status of a
// `dscl -read ... PrimaryGroupID` can never tell "has a GID" from "has none".

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const fakeDsclScript = `#!/bin/sh
state="$FAKE_DSCL_STATE"
echo "$*" >> "$state/calls"
if [ "$1" != "." ]; then echo "fake dscl: unsupported node $1" >&2; exit 2; fi
op=$2; path=$3; attr=$4; val=$5
name=${path#/Groups/}
d="$state/groups/$name"
case "$op" in
-read)
  if [ -n "$FAKE_DSCL_FAIL_READ" ]; then echo "<dscl_cmd> DS Error: -14987 (eServerNotRunning)" >&2; exit 70; fi
  if [ ! -d "$d" ]; then echo "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)" >&2; exit 56; fi
  if [ -z "$attr" ]; then
    for f in "$d"/*; do [ -f "$f" ] && echo "$(basename "$f"): $(cat "$f")"; done
    echo "RecordName: $name"
    exit 0
  fi
  if [ -f "$d/$attr" ]; then
    if [ -n "$FAKE_DSCL_FOLD" ]; then printf '%s:\n %s\n' "$attr" "$(cat "$d/$attr")"
    else echo "$attr: $(cat "$d/$attr")"; fi
  else
    echo "No such key: $attr"
  fi
  exit 0;;
-list)
  for g in "$state"/groups/*; do
    [ -d "$g" ] || continue
    n=$(basename "$g")
    if [ -f "$g/$attr" ]; then echo "$n                $(cat "$g/$attr")"; else echo "$n"; fi
  done
  exit 0;;
-create)
  if [ -n "$FAKE_DSCL_FAIL_CREATE" ]; then echo "fake dscl: create refused" >&2; exit 1; fi
  mkdir -p "$d"
  if [ -n "$attr" ]; then printf '%s' "$val" > "$d/$attr"; fi
  exit 0;;
esac
echo "fake dscl: unsupported op $op" >&2
exit 2
`

type fakeDirectory struct {
	t     *testing.T
	state string
	bin   string
}

func newFakeDirectory(t *testing.T) *fakeDirectory {
	t.Helper()
	root := t.TempDir()
	f := &fakeDirectory{t: t, state: filepath.Join(root, "state"), bin: filepath.Join(root, "bin")}
	for _, d := range []string{filepath.Join(f.state, "groups"), f.bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(f.bin, "dscl"), []byte(fakeDsclScript), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

// group seeds a group record; attrs maps attribute name to value.
func (f *fakeDirectory) group(name string, attrs map[string]string) {
	f.t.Helper()
	d := filepath.Join(f.state, "groups", name)
	if err := os.MkdirAll(d, 0o755); err != nil {
		f.t.Fatal(err)
	}
	for k, v := range attrs {
		if err := os.WriteFile(filepath.Join(d, k), []byte(v), 0o644); err != nil {
			f.t.Fatal(err)
		}
	}
}

// takeGIDs seeds placeholder groups holding each GID in [from, to].
func (f *fakeDirectory) takeGIDs(from, to int) {
	for gid := from; gid <= to; gid++ {
		f.group("taken"+strconv.Itoa(gid), map[string]string{"PrimaryGroupID": strconv.Itoa(gid)})
	}
}

// attr returns the attribute value and whether the attribute exists.
func (f *fakeDirectory) attr(group, name string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(f.state, "groups", group, name))
	if os.IsNotExist(err) {
		return "", false
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return string(b), true
}

func (f *fakeDirectory) calls() []string {
	b, err := os.ReadFile(filepath.Join(f.state, "calls"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func (f *fakeDirectory) resetCalls() {
	_ = os.Remove(filepath.Join(f.state, "calls"))
}

// writes returns every mutating dscl call made so far.
func (f *fakeDirectory) writes() []string {
	var out []string
	for _, c := range f.calls() {
		if strings.Contains(c, "-create") || strings.Contains(c, "-append") || strings.Contains(c, "-delete") {
			out = append(out, c)
		}
	}
	return out
}

// ensureShells is every shell the script must work under: /bin/sh is how the
// daemon and `breeze-agent service install` run it (EnsureIPCGroup), and bash
// with `set -euo pipefail` is how scripts/install/install-darwin.sh sources it.
// The .pkg postinstall sources it under bash `set -e`, a subset of the latter.
var ensureShells = []struct {
	name string
	run  func(t *testing.T) []string
}{
	{"sh (daemon)", func(t *testing.T) []string { return []string{"/bin/sh", "-c", ensureIPCGroupScript} }},
	{"bash pipefail (installers)", func(t *testing.T) []string {
		lib, err := filepath.Abs(ensureIPCGroupLibFile)
		if err != nil {
			t.Fatal(err)
		}
		return []string{"bash", "-c", "set -euo pipefail\n. '" + lib + "'\nensure_breeze_group\n"}
	}},
}

func (f *fakeDirectory) runEnsure(t *testing.T, argv []string, env ...string) (string, int) {
	t.Helper()
	if _, err := exec.LookPath(argv[0]); err != nil {
		t.Skipf("%s not available", argv[0])
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(),
		"PATH="+f.bin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"FAKE_DSCL_STATE="+f.state)
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("run ensure script: %v", err)
	}
	return string(out), code
}

func TestEnsureIPCGroupScript(t *testing.T) {
	for _, sh := range ensureShells {
		t.Run(sh.name, func(t *testing.T) {
			t.Run("absent group is created at the first free GID", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.takeGIDs(350, 351)
				out, code := f.runEnsure(t, sh.run(t))
				if code != 0 {
					t.Fatalf("exit %d: %s", code, out)
				}
				if gid, _ := f.attr("breeze", "PrimaryGroupID"); gid != "352" {
					t.Fatalf("PrimaryGroupID = %q, want 352 (350 and 351 are taken)", gid)
				}
			})

			t.Run("existing group with a valid GID is left untouched", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.group("breeze", map[string]string{"PrimaryGroupID": "401", "GroupMembership": "admin alice"})
				out, code := f.runEnsure(t, sh.run(t))
				if code != 0 {
					t.Fatalf("exit %d: %s", code, out)
				}
				if w := f.writes(); len(w) != 0 {
					t.Fatalf("a valid group must not be rewritten; got writes %q", w)
				}
				if gid, _ := f.attr("breeze", "PrimaryGroupID"); gid != "401" {
					t.Fatalf("PrimaryGroupID = %q, want 401 unchanged", gid)
				}
			})

			t.Run("folded dscl output still reads as a valid GID", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.group("breeze", map[string]string{"PrimaryGroupID": "401"})
				out, code := f.runEnsure(t, sh.run(t), "FAKE_DSCL_FOLD=1")
				if code != 0 {
					t.Fatalf("exit %d: %s", code, out)
				}
				if w := f.writes(); len(w) != 0 {
					t.Fatalf("a valid group must not be rewritten; got writes %q", w)
				}
			})

			// The #7829 field state: the record exists, carries a membership, and
			// has no PrimaryGroupID at all.
			t.Run("existing group without a GID is repaired in place", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.takeGIDs(350, 350)
				f.group("breeze", map[string]string{"GroupMembership": "admin"})
				out, code := f.runEnsure(t, sh.run(t))
				if code != 0 {
					t.Fatalf("exit %d: %s", code, out)
				}
				if gid, ok := f.attr("breeze", "PrimaryGroupID"); !ok || gid != "351" {
					t.Fatalf("PrimaryGroupID = %q (present=%v), want 351", gid, ok)
				}
				if m, _ := f.attr("breeze", "GroupMembership"); m != "admin" {
					t.Fatalf("GroupMembership = %q, want the existing membership kept", m)
				}
				for _, c := range f.writes() {
					if c == ". -create /Groups/breeze" {
						t.Fatalf("existing record must not be re-created; calls %q", f.writes())
					}
				}
				if !strings.Contains(out, "351") {
					t.Fatalf("repair should say which GID it assigned; output %q", out)
				}

				// Idempotent: a second run (reinstall, next daemon start) is a no-op.
				f.resetCalls()
				out, code = f.runEnsure(t, sh.run(t))
				if code != 0 {
					t.Fatalf("second run exit %d: %s", code, out)
				}
				if w := f.writes(); len(w) != 0 {
					t.Fatalf("second run must not write; got %q", w)
				}
				if gid, _ := f.attr("breeze", "PrimaryGroupID"); gid != "351" {
					t.Fatalf("PrimaryGroupID after second run = %q, want 351", gid)
				}
			})

			t.Run("non-numeric GID is repaired", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.group("breeze", map[string]string{"PrimaryGroupID": "abc"})
				out, code := f.runEnsure(t, sh.run(t))
				if code != 0 {
					t.Fatalf("exit %d: %s", code, out)
				}
				if gid, _ := f.attr("breeze", "PrimaryGroupID"); gid != "350" {
					t.Fatalf("PrimaryGroupID = %q, want 350", gid)
				}
			})

			t.Run("no free GID fails loudly", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.takeGIDs(350, 499)
				f.group("breeze", map[string]string{"GroupMembership": "admin"})
				out, code := f.runEnsure(t, sh.run(t))
				if code == 0 {
					t.Fatalf("want a non-zero exit when 350-499 are all taken; output %q", out)
				}
				if _, ok := f.attr("breeze", "PrimaryGroupID"); ok {
					t.Fatal("no GID may be assigned when the range is exhausted")
				}
				if !strings.Contains(out, "no free") {
					t.Fatalf("error should name the cause; output %q", out)
				}
			})

			// A read failure other than eDSRecordNotFound (wedged opendirectoryd,
			// timeout) must not be read as "absent" or "no GID": either would
			// overwrite a valid GID and orphan everything group-owned by it.
			t.Run("an unreadable record is never written", func(t *testing.T) {
				for _, seeded := range []map[string]string{
					{"PrimaryGroupID": "401", "GroupMembership": "admin"},
					nil, // record absent
				} {
					f := newFakeDirectory(t)
					if seeded != nil {
						f.group("breeze", seeded)
					}
					out, code := f.runEnsure(t, sh.run(t), "FAKE_DSCL_FAIL_READ=1")
					if code == 0 {
						t.Fatalf("seeded %v: want a non-zero exit when the record cannot be read; output %q", seeded, out)
					}
					if w := f.writes(); len(w) != 0 {
						t.Fatalf("seeded %v: an unreadable record must not be written; got %q", seeded, w)
					}
					if !strings.Contains(out, "eServerNotRunning") {
						t.Fatalf("seeded %v: the dscl error should be surfaced; output %q", seeded, out)
					}
				}
			})

			t.Run("a write that does not take is reported as a failure", func(t *testing.T) {
				f := newFakeDirectory(t)
				f.group("breeze", map[string]string{"GroupMembership": "admin"})
				out, code := f.runEnsure(t, sh.run(t), "FAKE_DSCL_FAIL_CREATE=1")
				if code == 0 {
					t.Fatalf("want a non-zero exit when dscl -create fails; output %q", out)
				}
			})
		})
	}
}

// The library hardcodes the group name (it is sourced by plain shell scripts),
// so pin it to the Go constant the socket owner is resolved by.
func TestEnsureIPCGroupLibNamesIPCGroup(t *testing.T) {
	if !strings.Contains(ensureIPCGroupLib, "/Groups/"+IPCGroupName+" ") {
		t.Fatalf("%s does not operate on /Groups/%s", ensureIPCGroupLibFile, IPCGroupName)
	}
	if strings.Contains(ensureIPCGroupLib, "\nset ") {
		t.Fatalf("%s must not change shell options: it is sourced by the installers", ensureIPCGroupLibFile)
	}
}
