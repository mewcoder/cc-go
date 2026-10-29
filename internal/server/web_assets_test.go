package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevelopmentAssetsReadSavedChangesWithoutRebuildingOrServingOtherFiles(t *testing.T) {
	a := testApp(t)
	a.cfg.DevAssets = t.TempDir()
	file := filepath.Join(a.cfg.DevAssets, "host.css")
	get := func(name string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/"+name, nil))
		return w
	}
	for _, css := range []string{"/* first edit */", "/* second edit */"} {
		if err := os.WriteFile(file, []byte(css), 0600); err != nil {
			t.Fatal(err)
		}
		w := get("host.css")
		if w.Code != 200 || w.Body.String() != css || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("development edit was not served fresh: %d %s", w.Code, w.Body.String())
		}
	}
	if w := get("settings-width.js"); w.Code != 404 {
		t.Fatal("missing development assets must not silently fall back to a stale embedded copy")
	}
	if err := os.WriteFile(filepath.Join(a.cfg.DevAssets, "private.json"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"private.json", "../desktop.json", "runtime/extension-host.cjs"} {
		if w := get(name); w.Code != 404 {
			t.Fatal("development mode exposed a non-web asset:", name)
		}
	}
	a.cfg.DevAssets = ""
	if w := get("host.css"); w.Code != 200 || strings.Contains(w.Body.String(), "second edit") {
		t.Fatal("packaged/default mode must keep using embedded assets")
	}
}

func TestDevelopmentAssetsRequireAnExplicitExistingWebDirectory(t *testing.T) {
	_, err := New(Config{DataDir: t.TempDir(), DevAssets: filepath.Join(t.TempDir(), "missing")})
	if err == nil || !strings.Contains(err.Error(), "development web assets") {
		t.Fatal("invalid development directory accepted:", err)
	}
}
