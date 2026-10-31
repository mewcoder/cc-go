package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodeThemeCatalogAndEmbeddedPalettes(t *testing.T) {
	a := testApp(t)
	a.views["chat"] = newView("chat", "Chat", "test")
	if len(codeThemeCatalog) != 9 {
		t.Fatalf("expected 9 paired families, got %d", len(codeThemeCatalog))
	}
	for _, family := range codeThemeCatalog {
		for kind, id := range map[string]string{"light": family.Light, "dark": family.Dark} {
			for _, base := range []string{a.ShellURL, a.ViewURL + "/view/chat/test"} {
				w := httptest.NewRecorder()
				request := httptest.NewRequest("GET", base+"/code-themes/"+id+".json", nil)
				if base == a.ShellURL {
					a.Handler().ServeHTTP(w, request)
				} else {
					a.ViewHandler().ServeHTTP(w, request)
				}
				var palette struct{ Name, Type string }
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &palette) != nil || palette.Type != kind || palette.Name != id {
					t.Fatalf("%s: %d, %+v", id, w.Code, palette)
				}
			}
		}
	}
	for _, name := range []string{"slack-ochin.json", "slack-dark.json", "claude-light.json", "claude-dark.json", "one-dark-pro.json", "ayu-light.json", "ayu-dark.json", "dracula.json", "../theme.css", "default.json", "catalog.json/other"} {
		w := httptest.NewRecorder()
		serveCodeTheme(w, httptest.NewRequest("GET", "/", nil), name)
		if w.Code != http.StatusNotFound {
			t.Fatalf("unexpected palette served: %s", name)
		}
	}
}

func TestThemeFamilySwitchesModesPersistsAndBroadcasts(t *testing.T) {
	a := testApp(t)
	for _, id := range []string{"active", "background"} {
		a.views[id] = newView(id, id, "test")
		a.views[id].HasDraft = true
	}
	for _, family := range codeThemeCatalog {
		for _, step := range []struct{ choice, want string }{{family.ID, family.Dark}, {"light", family.Light}, {"dark", family.Dark}} {
			w := postAPI(a, "/api/theme", map[string]any{"theme": step.choice})
			if w.Code != 200 || a.snapshot()["theme"] != step.want || a.snapshot()["themeFamily"] != family.ID {
				t.Fatalf("save %s: %d %s", step.choice, w.Code, w.Body.String())
			}
			for _, view := range a.views {
				var message struct {
					Family codeThemeInfo `json:"_claudeHostThemeFamily"`
					Theme  string        `json:"_claudeHostTheme"`
					Kind   string        `json:"_claudeHostThemeKind"`
				}
				if err := json.Unmarshal(view.messages[len(view.messages)-1].Data, &message); err != nil || message.Family != family || message.Theme != step.want || message.Kind != themeKind(step.want) {
					t.Fatalf("invalid theme broadcast: %+v, %v", message, err)
				}
				if !view.HasDraft || view.Revision != 0 {
					t.Fatal("theme must preserve loaded views and drafts")
				}
			}
			restored, err := New(a.cfg)
			if err != nil {
				t.Fatal(err)
			}
			if restored.state.Theme != step.want {
				t.Fatalf("restored %s, want %s", restored.state.Theme, step.want)
			}
			restored.Close()
		}
	}
	for _, choice := range []string{"light", "default", "dark"} {
		if w := postAPI(a, "/api/theme", map[string]any{"theme": choice}); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	if a.state.Theme != "dark" {
		t.Fatal("Default must return to the original light/dark palettes")
	}
}

func TestCodeThemeAdapterPatchesOnlyRecognizedBundle(t *testing.T) {
	source := `setTheme:r3.setTheme,languages:lang.getLanguages();if($.contains("vscode-light"))return"vs";return"vs-dark"`
	patched, ok := patchCodeThemeAdapter(source)
	if !ok || !strings.Contains(patched, "window.__goCodeThemes.attach(r3)") || !strings.Contains(patched, `resolve("vs-dark")`) {
		t.Fatal("Monaco theme hook missing")
	}
	for _, unsupported := range []string{"new plugin format", source + source, strings.Split(source, ";")[0]} {
		if result, ok := patchCodeThemeAdapter(unsupported); ok || result != unsupported {
			t.Fatal("unrecognized bundle must be left intact")
		}
	}
	a := testApp(t)
	root := filepath.Join(t.TempDir(), "webview")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "index.js")
	if err := os.WriteFile(file, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	view := newView("chat", "Chat", "test")
	view.Roots = []string{root}
	a.views[view.ID] = view
	w := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(w, httptest.NewRequest("GET", a.ViewURL+"/resource/chat/test"+file, nil))
	if w.Code != 200 || w.Body.String() != patched {
		t.Fatalf("bundle adaptation not served: %d", w.Code)
	}
	original, _ := os.ReadFile(file)
	if string(original) != source {
		t.Fatal("bundled plugin on disk must remain unchanged")
	}
	a.state.Theme = "one-dark"
	w = httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(w, httptest.NewRequest("GET", a.ViewURL+"/view/chat/test/bridge.js", nil))
	if !strings.Contains(w.Body.String(), `"themeFamily":{"id":"one","label":"One","light":"one-light","dark":"one-dark"}`) {
		t.Fatal("reloaded views must receive both selected palettes")
	}
}
