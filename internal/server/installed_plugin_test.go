package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cc-go/internal/plugin"
)

func installedPluginFixture(t *testing.T, root, version string) string {
	t.Helper()
	prepared, err := plugin.Prepare(fixtureArchiveVersion(t, version), t.TempDir(), plugin.Platform(), version)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "anthropic.claude-code-"+version+"-"+plugin.Platform())
	if err := os.CopyFS(directory, os.DirFS(prepared.ExtensionPath)); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(filepath.Dir(prepared.ExtensionPath), "extension.vsixmanifest"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, ".vsixmanifest"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestFirstSetupReusesInstalledVSCodePluginOfflineAndKeepsPrivateCopy(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	root := t.TempDir()
	source := installedPluginFixture(t, root, "1.2.4")
	a.mu.Lock()
	a.cfg.VSCodeExtensionsDirs = []string{root}
	a.mu.Unlock()
	replaceRecoveryTransport(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("offline: unexpected request to " + r.URL.String())
	}))
	if w := postAPI(a, "/api/retry", map[string]any{}); w.Code != 200 {
		t.Fatalf("offline initial setup failed: %d %s", w.Code, w.Body.String())
	}
	a.mu.Lock()
	archive, runtime, version, status, peer := a.state.Archive, a.runtimePath, a.version, a.setupStatus, a.peer
	dataDir := a.cfg.DataDir
	a.mu.Unlock()
	if version != "1.2.4" || runtime == "" || status != "ready" || peer != nil {
		t.Fatal("installed plugin did not reach readiness without activating the host")
	}
	if !strings.HasPrefix(archive, filepath.Join(dataDir, "vsix")+string(filepath.Separator)) || persistedState(t, a).Archive != archive {
		t.Fatal("initialization did not persist a private archive:", archive)
	}
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	// A newer VS Code installation must not silently replace CC Go's saved copy.
	installedPluginFixture(t, root, "1.2.5")
	if err := a.prepare(t.Context(), ""); err != nil {
		t.Fatal("saved copy did not work offline after VS Code removed the original:", err)
	}
	a.mu.Lock()
	unchanged := a.state.Archive == archive && a.version == "1.2.4"
	a.mu.Unlock()
	if !unchanged {
		t.Fatal("returning setup unexpectedly imported a different installed plugin")
	}
}

func TestInstalledVSCodePluginDoesNotOverrideExplicitOrRememberedArchive(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "remembered", true: "explicit"}[explicit], func(t *testing.T) {
			a := testApp(t)
			useTestNode(t, a)
			root := t.TempDir()
			installedPluginFixture(t, root, "1.2.5")
			archive := fixtureArchiveVersion(t, "1.2.3")
			a.mu.Lock()
			a.cfg.VSCodeExtensionsDirs = []string{root}
			if explicit {
				a.cfg.VSIX = archive
			} else {
				a.state.Archive = archive
			}
			a.mu.Unlock()
			if w := postAPI(a, "/api/retry", map[string]any{}); w.Code != 200 {
				t.Fatalf("setup failed: %d %s", w.Code, w.Body.String())
			}
			a.mu.Lock()
			unchanged := a.state.Archive == archive && a.version == "1.2.3"
			a.mu.Unlock()
			if !unchanged {
				t.Fatal("installed plugin overrode an explicitly selected or saved archive")
			}
		})
	}
}

func TestInstalledVSCodePluginFallbackDownloadsLatestStable(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	root := t.TempDir()
	directory := installedPluginFixture(t, root, "1.2.4")
	if err := os.Remove(filepath.Join(directory, ".vsixmanifest")); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.cfg.VSCodeExtensionsDirs = []string{root}
	a.mu.Unlock()
	requests := fixtureRegistry(t, "1.2.5")
	if err := a.prepare(t.Context(), ""); err != nil {
		t.Fatal("unusable installed plugin prevented download fallback:", err)
	}
	a.mu.Lock()
	downloaded := a.version == "1.2.5" && a.setupStatus == "ready"
	a.mu.Unlock()
	if !downloaded || *requests != 3 {
		t.Fatal("fallback did not use the normal verified registry download")
	}
}

func TestCancelledInstalledPluginSetupDoesNotDownload(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	root := t.TempDir()
	installedPluginFixture(t, root, "1.2.4")
	a.mu.Lock()
	a.cfg.VSCodeExtensionsDirs = []string{root}
	a.mu.Unlock()
	replaceRecoveryTransport(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("must not download after cancellation: " + r.URL.String())
	}))
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := a.prepare(ctx, ""); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was not propagated:", err)
	}
}
