package rebuild

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// writeTree creates files (relative slash paths -> content) under root.
func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// debianTree is a restored Debian-family tree: its own boot tools, a vendor
// directory on the ESP with shim and grub, no EFI/BOOT fallback loader.
func debianTree() map[string]string {
	return map[string]string{
		"etc/os-release":                  "ID=ubuntu\n",
		"usr/sbin/update-grub":            "#!/bin/sh\n",
		"usr/sbin/grub-install":           "#!/bin/sh\n",
		"usr/sbin/update-initramfs":       "#!/bin/sh\n",
		"boot/grub/grub.cfg":              "set default=0\n",
		"boot/efi/EFI/ubuntu/shimx64.efi": "shim",
		"boot/efi/EFI/ubuntu/grubx64.efi": "grub",
		"boot/efi/EFI/ubuntu/grub.cfg":    "search.fs_uuid x root\n",
	}
}

// rhelTree is a restored RHEL-family tree whose ESP vendor directory name
// (redhat) differs from its os-release ID (rhel).
func rhelTree() map[string]string {
	return map[string]string{
		"etc/os-release":                  "ID=\"rhel\"\n",
		"usr/sbin/grub2-mkconfig":         "#!/bin/sh\n",
		"usr/sbin/dracut":                 "#!/bin/sh\n",
		"boot/grub2/grub.cfg":             "set default=0\n",
		"boot/efi/EFI/redhat/shimx64.efi": "shim",
		"boot/efi/EFI/redhat/grubx64.efi": "grub",
	}
}

func bootRun(t *testing.T, tree map[string]string, opts Options) (*run, *fakeSystem) {
	t.Helper()
	dir := t.TempDir()
	staging := filepath.Join(dir, "mnt")
	writeTree(t, staging, tree)
	sys := newFakeSystem(dir, 100*GiB)
	plan := &Plan{Partitions: []PlannedPartition{{Number: 1, Role: layout.RoleEFI}, {Number: 2, Role: layout.RoleRoot}}}
	r := &run{opts: opts, sys: sys, staging: staging, disk: "/dev/sdb", result: &Result{Plan: plan}}
	return r, sys
}

// withEFIVars points the host firmware-variable directory at a directory
// that exists (present=true) or one that does not.
func withEFIVars(t *testing.T, present bool) {
	t.Helper()
	prev := hostEFIVarsDir
	d := filepath.Join(t.TempDir(), "efivars")
	if present {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	hostEFIVarsDir = d
	t.Cleanup(func() { hostEFIVarsDir = prev })
}

func withRecoveryMedia(t *testing.T, on bool) {
	t.Helper()
	prev := onRecoveryMedia
	onRecoveryMedia = func() bool { return on }
	t.Cleanup(func() { onRecoveryMedia = prev })
}

// assertNoRestoredTool fails when the boot phase ran anything from the
// restored tree or prepared the host's device and kernel interfaces for it.
func assertNoRestoredTool(t *testing.T, sys *fakeSystem) {
	t.Helper()
	for _, c := range sys.cmds {
		for _, banned := range []string{"chroot", "mount --bind", "grub-install", "update-grub", "update-initramfs", "grub2-mkconfig", "dracut"} {
			if strings.HasPrefix(c, banned) || strings.Contains(c, " "+banned) {
				t.Fatalf("boot phase ran %q:\n%s", c, sys.dump())
			}
		}
	}
}

func TestBoot_DefaultRunsNoRestoredSystemTool(t *testing.T) {
	for name, tree := range map[string]map[string]string{"debian": debianTree(), "rhel": rhelTree()} {
		for _, kind := range []TargetKind{TargetDisk, TargetImage} {
			t.Run(name+"/"+string(kind), func(t *testing.T) {
				withEFIVars(t, true)
				withRecoveryMedia(t, true)
				r, sys := bootRun(t, tree, Options{Target: Target{Kind: kind, Path: "/dev/sdb"}})
				if err := boot(context.Background(), r); err != nil {
					t.Fatalf("boot: %v\n%s", err, sys.dump())
				}
				assertNoRestoredTool(t, sys)
				vendor := "ubuntu"
				if name == "rhel" {
					vendor = "redhat"
				}
				got, err := os.ReadFile(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "BOOTX64.EFI"))
				if err != nil || string(got) != "shim" {
					t.Fatalf("fallback loader = %q, %v; want the vendor shim", got, err)
				}
				if got, err := os.ReadFile(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "grubx64.efi")); err != nil || string(got) != "grub" {
					t.Fatalf("fallback grub = %q, %v", got, err)
				}
				entry := `efibootmgr --create --disk /dev/sdb --part 1 --label ` + vendor + ` --loader \EFI\` + vendor + `\shimx64.efi`
				if kind == TargetDisk && !sys.has(entry) {
					t.Fatalf("missing host firmware boot entry %q\n%s", entry, sys.dump())
				}
				if kind != TargetDisk && sys.has("efibootmgr") {
					t.Fatalf("an image target must not touch the host firmware entries\n%s", sys.dump())
				}
			})
		}
	}
}

func TestBoot_NoFirmwareVariablesNoBootEntry(t *testing.T) {
	withEFIVars(t, false)
	r, sys := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v\n%s", err, sys.dump())
	}
	assertNoRestoredTool(t, sys)
	if sys.has("efibootmgr") {
		t.Fatalf("no firmware variables on the host, yet a boot entry was written\n%s", sys.dump())
	}
}

func TestBoot_BootEntryFailureIsAWarning(t *testing.T) {
	withEFIVars(t, true)
	withRecoveryMedia(t, true)
	r, sys := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	sys.fail["efibootmgr"] = errors.New("no space")
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v", err)
	}
	if len(r.warnings) == 0 || !strings.Contains(strings.Join(r.warnings, "\n"), "firmware fallback") {
		t.Fatalf("warnings = %v", r.warnings)
	}
}

func TestBoot_KeepsExistingFallbackLoader(t *testing.T) {
	withEFIVars(t, false)
	tree := debianTree()
	tree["boot/efi/EFI/BOOT/BOOTX64.EFI"] = "existing"
	r, sys := bootRun(t, tree, Options{Target: Target{Kind: TargetImage}})
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v", err)
	}
	assertNoRestoredTool(t, sys)
	if got, _ := os.ReadFile(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "BOOTX64.EFI")); string(got) != "existing" {
		t.Fatalf("fallback loader replaced: %q", got)
	}
}

// The fallback loader is the one for the host architecture: an x86-64 ESP
// never supplies an arm64 fallback loader.
func TestBoot_FallbackLoaderMatchesArchitecture(t *testing.T) {
	withEFIVars(t, false)
	r, sys := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetImage}})
	sys.arch = "arm64"
	err := boot(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "BOOTAA64.EFI") {
		t.Fatalf("err = %v, want no arm64 fallback loader", err)
	}
	if _, statErr := os.Stat(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "BOOTAA64.EFI")); statErr == nil {
		t.Fatal("an x86-64 loader was installed as the arm64 fallback loader")
	}
}

func TestBoot_NoLoaderOnTheESPFails(t *testing.T) {
	withEFIVars(t, true)
	tree := debianTree()
	delete(tree, "boot/efi/EFI/ubuntu/shimx64.efi")
	delete(tree, "boot/efi/EFI/ubuntu/grubx64.efi")
	r, sys := bootRun(t, tree, Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	err := boot(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "BOOTX64.EFI") {
		t.Fatalf("err = %v", err)
	}
	assertNoRestoredTool(t, sys)
}

// The boot phase never runs the restored system's tools, whatever options
// reached it: Run refuses those options first, and the phase refuses them
// again.
func TestBoot_RestoredToolOptionsNeverRunTheTools(t *testing.T) {
	withEFIVars(t, true)
	withRecoveryMedia(t, true)
	for _, opts := range []Options{
		{RestoredBootTools: true, ConfirmRestoredBootTools: true},
		{RegenerateInitramfs: true, ConfirmRestoredBootTools: true},
	} {
		opts.Target = Target{Kind: TargetDisk, Path: "/dev/sdb"}
		r, sys := bootRun(t, debianTree(), opts)
		err := boot(context.Background(), r)
		var ref *RefusalError
		if !errors.As(err, &ref) {
			t.Fatalf("err = %v, want a refusal", err)
		}
		assertNoRestoredTool(t, sys)
	}
}

// restoredToolsRunOptions is a dry run that would otherwise complete on this
// host: a refusal is the only way it can fail.
func restoredToolsRunOptions(t *testing.T) (Options, *fakeSystem, *memProvider) {
	t.Helper()
	withHostPlatform(t, "linux")
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	return Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew,
		StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), DryRun: true, System: sys}, sys, p
}

func TestRun_DefaultOptionsDryRunCompletes(t *testing.T) {
	opts, _, _ := restoredToolsRunOptions(t)
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestRun_RestoredBootToolsRefusedBeforeAnything(t *testing.T) {
	cases := []struct {
		name     string
		set      func(*Options)
		media    bool
		wantCode string
	}{
		{"opt-in without confirmation", func(o *Options) { o.RestoredBootTools = true }, true, RefusalCodeRestoredBootToolsUnconfirmed},
		{"opt-in without confirmation on an installed-agent host", func(o *Options) { o.RestoredBootTools = true }, false, RefusalCodeRestoredBootToolsUnconfirmed},
		{"initramfs regeneration without confirmation", func(o *Options) { o.RegenerateInitramfs = true }, true, RefusalCodeRestoredBootToolsUnconfirmed},
		{"confirmation alone is no opt-in", func(o *Options) { o.ConfirmRestoredBootTools = true }, false, ""},
		{"opt-in on an installed-agent host", func(o *Options) { o.RestoredBootTools, o.ConfirmRestoredBootTools = true, true }, false, RefusalCodeRestoredBootToolsAgentHost},
		{"initramfs regeneration on an installed-agent host", func(o *Options) { o.RegenerateInitramfs, o.ConfirmRestoredBootTools = true, true }, false, RefusalCodeRestoredBootToolsAgentHost},
		{"opt-in on recovery media without an isolated runner", func(o *Options) { o.RestoredBootTools, o.ConfirmRestoredBootTools = true, true }, true, RefusalCodeRestoredBootToolsUnisolated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withRecoveryMedia(t, tc.media)
			opts, sys, p := restoredToolsRunOptions(t)
			tc.set(&opts)
			if tc.wantCode == "" {
				if res, err := Run(context.Background(), opts); err != nil || res.Status != "completed" {
					t.Fatalf("res=%+v err=%v", res, err)
				}
				return
			}
			p.failKey = map[string]error{"snapshots/snap-1/layout.json": errors.New("layout must not be fetched when the options are refused")}
			opts.DryRun = false
			res, err := Run(context.Background(), opts)
			var ref *RefusalError
			if !errors.As(err, &ref) || res == nil || res.Status != "refused" {
				t.Fatalf("res=%+v err=%v, want a refusal", res, err)
			}
			if res.RefusalCode != tc.wantCode || ref.Code != tc.wantCode {
				t.Fatalf("refusal code = %q / %q, want %q (%s)", res.RefusalCode, ref.Code, tc.wantCode, res.Refusal)
			}
			if res.PhaseReached != PhasePreflight || len(res.Phases) != 1 || res.Phases[0].Status != PhaseRefused {
				t.Fatalf("phases = %+v, want one refused preflight row", res.Phases)
			}
			if len(sys.cmds) != 0 {
				t.Fatalf("system touched before the refusal:\n%s", sys.dump())
			}
		})
	}
}

func TestCmdlineMarksRecoveryMedia(t *testing.T) {
	for in, want := range map[string]bool{
		"boot=live components quiet breeze.media=1 console=ttyS0\n": true,
		"breeze.media=1": true,
		"BOOT_IMAGE=/vmlinuz root=UUID=x ro quiet": false,
		"breeze.media=0":  false,
		"breeze.media=10": false,
		"xbreeze.media=1": false,
		"breeze.media":    false,
		"":                false,
	} {
		if got := cmdlineMarksRecoveryMedia(in); got != want {
			t.Errorf("%q = %v, want %v", in, got, want)
		}
	}
}

// On a host with an installed agent the rebuild adds the firmware boot entry
// without putting it first in that host's boot order.
func TestBoot_BootEntryOnAgentHostKeepsBootOrder(t *testing.T) {
	withEFIVars(t, true)
	withRecoveryMedia(t, false)
	r, sys := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v", err)
	}
	want := `efibootmgr --create-only --disk /dev/sdb --part 1 --label ubuntu --loader \EFI\ubuntu\shimx64.efi`
	if !sys.has(want) {
		t.Fatalf("missing %q\n%s", want, sys.dump())
	}
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "efibootmgr --create ") {
			t.Fatalf("boot order changed on an installed-agent host: %q", c)
		}
	}
}

// A firmware entry that already points at the same loader on the same
// partition is reused, so a repeated or resumed run adds no duplicate.
func TestBoot_ExistingBootEntryIsReused(t *testing.T) {
	withEFIVars(t, true)
	withRecoveryMedia(t, true)
	r, sys := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	r.result.Plan.Partitions[0].PartUUID = "6B3C5B1E-0E5A-4F4B-9C55-0123456789AB"
	sys.outputs = map[string][]byte{"efibootmgr -v": []byte("BootCurrent: 0001\nBootOrder: 0003,0001\n" +
		"Boot0001* UEFI QEMU HARDDISK\tPciRoot(0x0)/Pci(0x1,0x0)\n" +
		"Boot0003* ubuntu\tHD(1,GPT,6b3c5b1e-0e5a-4f4b-9c55-0123456789ab,0x800,0x100000)/File(\\EFI\\UBUNTU\\SHIMX64.EFI)\n")}
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v", err)
	}
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "efibootmgr --create") {
			t.Fatalf("duplicate firmware entry created:\n%s", sys.dump())
		}
	}
	// A matching label on another partition is not this entry.
	r2, sys2 := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	r2.result.Plan.Partitions[0].PartUUID = "11111111-2222-3333-4444-555555555555"
	sys2.outputs = sys.outputs
	if err := boot(context.Background(), r2); err != nil {
		t.Fatalf("boot: %v", err)
	}
	if !sys2.has("efibootmgr --create --disk /dev/sdb") {
		t.Fatalf("entry for another partition taken as this one:\n%s", sys2.dump())
	}
}

// A loader reached through a link is not used: a linked file, or a vendor
// directory that is a link out of the ESP.
func TestBoot_LinkedVendorLoaderIsNotUsed(t *testing.T) {
	withEFIVars(t, false)
	tree := debianTree()
	tree["opt/elsewhere/shimx64.efi"] = "elsewhere"
	r, _ := bootRun(t, tree, Options{Target: Target{Kind: TargetImage}})
	shim := filepath.Join(r.staging, "boot", "efi", "EFI", "ubuntu", "shimx64.efi")
	if err := os.Remove(shim); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../../../opt/elsewhere/shimx64.efi", shim); err != nil {
		t.Fatal(err)
	}
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "BOOTX64.EFI")); string(got) != "grub" {
		t.Fatalf("fallback loader = %q, want the regular grub image, not the linked shim", got)
	}

	tree = debianTree()
	delete(tree, "boot/efi/EFI/ubuntu/shimx64.efi")
	delete(tree, "boot/efi/EFI/ubuntu/grubx64.efi")
	delete(tree, "boot/efi/EFI/ubuntu/grub.cfg")
	r, _ = bootRun(t, tree, Options{Target: Target{Kind: TargetImage}})
	writeTree(t, r.staging, map[string]string{"opt/esp/shimx64.efi": "elsewhere"})
	vendor := filepath.Join(r.staging, "boot", "efi", "EFI", "ubuntu")
	if err := os.MkdirAll(filepath.Dir(vendor), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../../opt/esp", vendor); err != nil {
		t.Fatal(err)
	}
	if err := boot(context.Background(), r); err == nil {
		got, _ := os.ReadFile(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "BOOTX64.EFI"))
		t.Fatalf("a loader behind a linked vendor directory was installed: %q", got)
	}
}

// The fallback loader and its companion are written without following a
// link at EFI/BOOT or at the destination file.
func TestBoot_FallbackWritesFollowNoLink(t *testing.T) {
	withEFIVars(t, false)
	t.Run("EFI/BOOT is a link", func(t *testing.T) {
		r, _ := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetImage}})
		outside := filepath.Join(r.staging, "var", "outside")
		if err := os.MkdirAll(outside, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("../../../var/outside", filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT")); err != nil {
			t.Fatal(err)
		}
		if err := boot(context.Background(), r); err == nil {
			t.Fatal("boot succeeded through a linked EFI/BOOT")
		}
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Fatalf("written through the link: %v", entries)
		}
	})
	t.Run("companion destination is a link", func(t *testing.T) {
		r, _ := bootRun(t, debianTree(), Options{Target: Target{Kind: TargetImage}})
		writeTree(t, r.staging, map[string]string{"etc/keep": "unchanged"})
		if err := os.MkdirAll(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("../../../../etc/keep", filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", "grubx64.efi")); err != nil {
			t.Fatal(err)
		}
		_ = boot(context.Background(), r)
		if got, _ := os.ReadFile(filepath.Join(r.staging, "etc", "keep")); string(got) != "unchanged" {
			t.Fatalf("written through the companion link: %q", got)
		}
	})
}

// Two vendor directories with loaders and no match for the os-release ID:
// the choice is ambiguous and nothing is copied or registered.
func TestBoot_AmbiguousVendorDirectoriesAreNotGuessed(t *testing.T) {
	withEFIVars(t, true)
	withRecoveryMedia(t, true)
	tree := rhelTree()
	tree["boot/efi/EFI/centos/shimx64.efi"] = "other"
	r, sys := bootRun(t, tree, Options{Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}})
	if err := boot(context.Background(), r); err == nil {
		t.Fatal("boot picked one of two vendor directories")
	}
	if sys.has("efibootmgr") {
		t.Fatalf("firmware entry written for a guessed vendor directory:\n%s", sys.dump())
	}
}

// A scanned directory whose name is not a valid bootloader id is ignored.
func TestBoot_InvalidVendorDirectoryNameIgnored(t *testing.T) {
	withEFIVars(t, false)
	tree := rhelTree()
	delete(tree, "boot/efi/EFI/redhat/shimx64.efi")
	delete(tree, "boot/efi/EFI/redhat/grubx64.efi")
	tree["boot/efi/EFI/-bad/shimx64.efi"] = "shim"
	r, _ := bootRun(t, tree, Options{Target: Target{Kind: TargetImage}})
	if err := boot(context.Background(), r); err == nil {
		t.Fatal("a loader in an invalid vendor directory name was used")
	}
}

// The ESP is found where the plan mounts it.
func TestBoot_ESPAtThePlannedMountPoint(t *testing.T) {
	withEFIVars(t, false)
	tree := map[string]string{
		"etc/os-release":           "ID=arch\n",
		"boot/grub/grub.cfg":       "set default=0\n",
		"efi/EFI/arch/grubx64.efi": "grub",
	}
	r, _ := bootRun(t, tree, Options{Target: Target{Kind: TargetImage}})
	r.result.Plan.Partitions[0].MountPoint = "/efi"
	if err := boot(context.Background(), r); err != nil {
		t.Fatalf("boot: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(r.staging, "efi", "EFI", "BOOT", "BOOTX64.EFI")); string(got) != "grub" {
		t.Fatalf("fallback loader under /efi = %q", got)
	}
}

// efibootmgr built on newer libefivar prints the loader path without the
// File(...) wrapper; that entry is recognised too, and a longer name that
// only starts with the loader path is not.
func TestHasBootEntryAcceptsBareLoaderPath(t *testing.T) {
	const guid = "6b3c5b1e-0e5a-4f4b-9c55-0123456789ab"
	loader := `\EFI\ubuntu\shimx64.efi`
	for line, want := range map[string]bool{
		"Boot0003* ubuntu\tHD(1,GPT," + guid + ",0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)":                   true,
		"Boot0003* ubuntu\tHD(1,GPT," + guid + ",0x800,0x100000)/\\EFI\\UBUNTU\\SHIMX64.EFI":                         true,
		"Boot0003* ubuntu\tHD(1,GPT," + guid + ",0x800,0x100000)/\\EFI\\ubuntu\\shimx64.efi.old":                     false,
		"Boot0003* ubuntu\tHD(1,GPT,11111111-2222-3333-4444-555555555555,0x800,0x100000)/\\EFI\\ubuntu\\shimx64.efi": false,
		"Boot0003* debian\tHD(1,GPT," + guid + ",0x800,0x100000)/\\EFI\\ubuntu\\shimx64.efi":                         false,
	} {
		if got := hasBootEntry("BootOrder: 0003\n"+line+"\n", "ubuntu", strings.ToUpper(guid), loader); got != want {
			t.Errorf("%q = %v, want %v", line, got, want)
		}
	}
}
