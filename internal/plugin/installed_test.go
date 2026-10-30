package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func installedFixture(t *testing.T, root, version, platform string) string {
	t.Helper()
	directory := filepath.Join(root, "anthropic.claude-code-"+version+"-"+platform)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	manifest, _ := json.Marshal(map[string]any{"publisher": "Anthropic", "name": "claude-code", "version": version, "main": "./extension.cjs", "__metadata": map[string]any{"targetPlatform": platform}})
	for name, data := range map[string][]byte{
		"package.json": manifest, "extension.cjs": []byte("exports.activate = () => {};"),
		".vsixmanifest": []byte(`<PackageManifest><Metadata><Identity TargetPlatform="` + platform + `"/></Metadata></PackageManifest>`),
	} {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeRuntime(t, directory, "native-binary", platform)
	return directory
}

func TestInstalledExtensionDirectories(t *testing.T) {
	home, portable := t.TempDir(), t.TempDir()
	want := []string{filepath.Join(portable, "extensions"), filepath.Join(home, ".vscode", "extensions"), filepath.Join(home, ".vscode-insiders", "extensions")}
	if got := VSCodeExtensionDirectories(home, portable); !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	if got := VSCodeExtensionDirectories(home, "relative-workspace-data"); !reflect.DeepEqual(got, want[1:]) {
		t.Fatal("relative portable paths must not load code from the workspace:", got)
	}
}

func TestReuseInstalledCreatesAnIndependentVerifiedCopyOnMacAndWindows(t *testing.T) {
	for _, platform := range []string{"darwin-arm64", "win32-x64"} {
		t.Run(platform, func(t *testing.T) {
			root, archives, cache := t.TempDir(), t.TempDir(), t.TempDir()
			source := installedFixture(t, root, "2.1.312", platform)
			originalManifest, _ := os.ReadFile(filepath.Join(source, "package.json"))
			installed, err := ReuseInstalled(t.Context(), []string{root}, archives, cache, platform)
			if err != nil || installed.Prepared == nil {
				t.Fatalf("local reuse failed: %+v %v", installed, err)
			}
			resolvedCache, err := filepath.EvalSymlinks(cache)
			if err != nil {
				t.Fatal(err)
			}
			if filepath.Dir(installed.Archive) != archives || !strings.HasPrefix(installed.Prepared.ExtensionPath, resolvedCache+string(filepath.Separator)) || installed.Prepared.PackageJSON["version"] != "2.1.312" {
				t.Fatal("import did not create a private copy:", installed)
			}
			if _, err := BundledRuntime(installed.Prepared.ExtensionPath, platform); err != nil {
				t.Fatal(err)
			}
			unchanged, _ := os.ReadFile(filepath.Join(source, "package.json"))
			if string(originalManifest) != string(unchanged) {
				t.Fatal("VS Code's package.json was rewritten")
			}
			if _, err := os.Stat(filepath.Join(source, ".receipt.json")); !os.IsNotExist(err) {
				t.Fatal("receipt must not be written into VS Code's installation")
			}
			second, err := ReuseInstalled(t.Context(), []string{root}, archives, cache, platform)
			if err != nil || installed.Archive != second.Archive {
				t.Fatal("unchanged imports should reuse the same content-addressed archive:", err)
			}
			if err := os.RemoveAll(source); err != nil {
				t.Fatal(err)
			}
			if _, err := Prepare(installed.Archive, cache, platform, "2.1.312"); err != nil {
				t.Fatal("removing the VS Code extension broke the imported copy:", err)
			}
			if err := os.WriteFile(filepath.Join(installed.Prepared.ExtensionPath, "extension.cjs"), []byte("changed"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Prepare(installed.Archive, cache, platform, ""); err == nil {
				t.Fatal("imported cache bypassed receipt verification")
			}
		})
	}
}

func TestReuseInstalledChoosesNewestStableAcrossRootsAndSkipsObsoleteVersions(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	installedFixture(t, first, "2.1.9", Platform())
	installedFixture(t, second, "2.1.10", Platform())
	installedFixture(t, first, "2.1.99-beta.1", Platform())
	obsolete := installedFixture(t, first, "2.2.0", Platform())
	data, _ := json.Marshal(map[string]bool{filepath.Base(obsolete): true})
	if err := os.WriteFile(filepath.Join(first, ".obsolete"), data, 0600); err != nil {
		t.Fatal(err)
	}
	installed, err := ReuseInstalled(t.Context(), []string{first, second}, t.TempDir(), t.TempDir(), Platform())
	if err != nil || installed.Prepared == nil || installed.Prepared.PackageJSON["version"] != "2.1.10" {
		t.Fatal("did not choose the numerically newest usable stable release:", installed, err)
	}
}

func TestReuseInstalledRejectsUnusableCandidates(t *testing.T) {
	for _, problem := range []string{"publisher", "name", "entry", "prerelease-metadata", "platform-metadata", "platform-manifest", "missing-runtime", "runtime-platform", "missing-vsixmanifest", "invalid-obsolete"} {
		t.Run(problem, func(t *testing.T) {
			root := t.TempDir()
			directory := installedFixture(t, root, "2.1.312", Platform())
			file := filepath.Join(directory, "package.json")
			data, _ := os.ReadFile(file)
			var manifest map[string]any
			_ = json.Unmarshal(data, &manifest)
			switch problem {
			case "publisher", "name":
				manifest[problem] = "other"
			case "entry":
				manifest["main"] = "../outside.cjs"
			case "prerelease-metadata":
				manifest["__metadata"].(map[string]any)["isPreReleaseVersion"] = true
			case "platform-metadata":
				manifest["__metadata"].(map[string]any)["targetPlatform"] = "wrong-platform"
			case "platform-manifest":
				_ = os.WriteFile(filepath.Join(directory, ".vsixmanifest"), []byte(`<PackageManifest/>`), 0600)
			case "missing-vsixmanifest":
				_ = os.Remove(filepath.Join(directory, ".vsixmanifest"))
			case "missing-runtime":
				_ = os.RemoveAll(filepath.Join(directory, "resources"))
			case "runtime-platform":
				binary, err := BundledRuntime(directory, Platform())
				if err != nil {
					t.Fatal(err)
				}
				_ = os.WriteFile(binary, binaryFixture("win32-arm64"), 0700)
			case "invalid-obsolete":
				_ = os.WriteFile(filepath.Join(root, ".obsolete"), []byte("not json"), 0600)
			}
			data, _ = json.Marshal(manifest)
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			installed, err := ReuseInstalled(t.Context(), []string{root}, t.TempDir(), t.TempDir(), Platform())
			if err != nil || installed.Prepared != nil || installed.Archive != "" {
				t.Fatal("unusable automatic candidate should be skipped:", installed, err)
			}
		})
	}
}

func TestReuseInstalledSkipsSymlinkedFilesAndFallsBackToOlderStable(t *testing.T) {
	root := t.TempDir()
	newer := installedFixture(t, root, "2.1.11", Platform())
	installedFixture(t, root, "2.1.10", Platform())
	outside := filepath.Join(t.TempDir(), "private")
	if err := os.WriteFile(outside, []byte("must not be copied"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(newer, "linked-file")); err != nil {
		t.Skip("symlink fixture unavailable:", err)
	}
	archives := t.TempDir()
	installed, err := ReuseInstalled(t.Context(), []string{root}, archives, t.TempDir(), Platform())
	if err != nil || installed.Prepared == nil || installed.Prepared.PackageJSON["version"] != "2.1.10" {
		t.Fatal("unsafe newest candidate did not fall back to an older usable version:", installed, err)
	}
	if parts, _ := filepath.Glob(filepath.Join(archives, ".vscode-*")); len(parts) != 0 {
		t.Fatal("partial import archives were not cleaned:", parts)
	}
}

func TestReuseInstalledHonorsCancellationWithoutLeavingTemporaryArchives(t *testing.T) {
	root, archives := t.TempDir(), t.TempDir()
	installedFixture(t, root, "2.1.312", Platform())
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := ReuseInstalled(ctx, []string{root}, archives, t.TempDir(), Platform())
	if !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled import continued:", err)
	}
	entries, _ := os.ReadDir(archives)
	if len(entries) != 0 {
		t.Fatal("cancelled import wrote archive files")
	}
}

func TestReuseInstalledNeverWritesCacheInsideVSCodeInstallation(t *testing.T) {
	for _, nested := range []string{"archives", "cache"} {
		t.Run(nested, func(t *testing.T) {
			root := t.TempDir()
			source := installedFixture(t, root, "2.1.312", Platform())
			archives, cache := t.TempDir(), t.TempDir()
			inside := filepath.Join(source, "cc-go", "cache")
			if nested == "archives" {
				archives = inside
			} else {
				cache = inside
			}
			installed, err := ReuseInstalled(t.Context(), []string{root}, archives, cache, Platform())
			if err == nil || installed.Prepared != nil {
				t.Fatal("import accepted a cache inside the VS Code extension")
			}
			if _, err := os.Stat(filepath.Join(source, "cc-go")); !os.IsNotExist(err) {
				t.Fatal("import modified the installed extension")
			}
		})
	}
}
