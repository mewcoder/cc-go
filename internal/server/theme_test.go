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

func TestThemePersistsBroadcastsAndUsesNativeColorScheme(t *testing.T) {
	a := testApp(t)
	var nativeThemes []string
	a.SetNative(Native{SetTheme: func(value string) { nativeThemes = append(nativeThemes, value) }})
	for _, id := range []string{"active", "background"} {
		a.views[id] = newView(id, id, "test")
		a.views[id].HasDraft = true
	}
	a.active = "active"
	for _, step := range []struct{ choice, theme string }{{"one", "one-dark"}, {"light", "one-light"}, {"default", "light"}, {"dark", "dark"}} {
		theme := step.theme
		w := postAPI(a, "/api/theme", map[string]any{"theme": step.choice})
		if w.Code != http.StatusOK || a.snapshot()["theme"] != theme {
			t.Fatalf("saving %s: %d %s", theme, w.Code, w.Body.String())
		}
		for _, view := range a.views {
			var message map[string]json.RawMessage
			if err := json.Unmarshal(view.messages[len(view.messages)-1].Data, &message); err != nil || string(message["_claudeHostTheme"]) != `"`+theme+`"` {
				t.Fatalf("theme not broadcast to %s: %v %v", view.ID, message, err)
			}
			if view.Revision != 0 || !view.HasDraft {
				t.Fatal("theme changes must preserve the view and its draft")
			}
		}
		b, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "desktop.json"))
		var saved DesktopState
		if err != nil || json.Unmarshal(b, &saved) != nil || saved.Theme != theme {
			t.Fatalf("theme not persisted: %s %v", b, err)
		}
	}
	if got := strings.Join(nativeThemes, ","); got != "dark,dark,light,light,dark" {
		t.Fatalf("native controls must receive a color scheme: %s", got)
	}
	if a.peer != nil {
		t.Fatal("changing the theme must not launch an extension host")
	}
}

func TestThemeRestoresAndNormalizesSavedState(t *testing.T) {
	for _, value := range []string{"", "invalid", "dark", "light", "one-dark", "claude-light", "claude-dark", "slack-ochin", "slack-dark", "vitesse-light", "vitesse-dark", "ayu-light", "ayu-dark"} {
		t.Run(value, func(t *testing.T) {
			a := testApp(t)
			a.state.Theme = value
			if err := a.saveLocked(); err != nil {
				t.Fatal(err)
			}
			restored, err := New(a.cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(restored.Close)
			want := value
			if want == "claude-light" || want == "slack-ochin" {
				want = "light"
			}
			if !validTheme(want) {
				want = "dark"
			}
			if restored.state.Theme != want {
				t.Fatalf("restored %q, want %q", restored.state.Theme, want)
			}
			var nativeTheme string
			restored.SetNative(Native{SetTheme: func(value string) { nativeTheme = value }})
			if nativeTheme != themeKind(want) {
				t.Fatalf("restored native theme = %q", nativeTheme)
			}
		})
	}
}

func TestThemeRejectsInvalidValuesAndRollsBackFailedSave(t *testing.T) {
	a := testApp(t)
	view := newView("chat", "Chat", "test")
	a.views[view.ID] = view
	var nativeUpdates int
	a.SetNative(Native{SetTheme: func(string) { nativeUpdates++ }})
	for _, value := range []any{nil, 12, true, "", "One Dark", "one-dark-darker"} {
		w := postAPI(a, "/api/theme", map[string]any{"theme": value})
		if w.Code != http.StatusBadRequest || a.state.Theme != "dark" || len(view.messages) != 0 {
			t.Fatalf("invalid theme accepted: %v %d %s", value, w.Code, w.Body.String())
		}
	}
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	w := postAPI(a, "/api/theme", map[string]any{"theme": "one-dark"})
	if w.Code != http.StatusBadRequest || a.state.Theme != "dark" || len(view.messages) != 0 || nativeUpdates != 1 {
		t.Fatal("a failed save must not change or broadcast the theme")
	}
}

func TestOneDarkUsesSharedPaletteForShellAndPlugin(t *testing.T) {
	a := testApp(t)
	a.state.Theme = "one-dark"
	a.views["chat"] = newView("chat", "Chat", "test")
	shell := httptest.NewRecorder()
	a.Handler().ServeHTTP(shell, httptest.NewRequest("GET", a.ShellURL+"/theme-palettes.css", nil))
	if shell.Code != http.StatusOK || !strings.Contains(strings.ToLower(shell.Body.String()), "--vscode-editor-background: #282c34;") ||
		!strings.Contains(strings.ToLower(shell.Body.String()), "--vscode-sidebar-background: #21252b;") {
		t.Fatal("standard One Dark palette must be available to the shell")
	}
	for _, theme := range []string{"one-dark", "dark", "light"} {
		a.state.Theme = theme
		view := httptest.NewRecorder()
		a.ViewHandler().ServeHTTP(view, httptest.NewRequest("GET", a.ViewURL+"/view/chat/test/theme.css", nil))
		hasPalette := strings.Contains(view.Body.String(), shell.Body.String())
		if view.Code != http.StatusOK || !hasPalette {
			t.Fatalf("plugin palette for %s: status %d, One Dark = %v", theme, view.Code, hasPalette)
		}
		bridge := httptest.NewRecorder()
		a.ViewHandler().ServeHTTP(bridge, httptest.NewRequest("GET", a.ViewURL+"/view/chat/test/bridge.js", nil))
		if bridge.Code != http.StatusOK || !strings.Contains(bridge.Body.String(), `"theme":"`+theme+`"`) {
			t.Fatalf("new/reloaded views must inherit %s", theme)
		}
	}
	for resource, content := range map[string]string{
		"shell.html":        `src="settings-theme.js"`,
		"settings-theme.js": "goThemeControl",
	} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/"+resource, nil))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), content) {
			t.Fatalf("theme control missing from %s", resource)
		}
	}
}

func TestVitesseControlsKeepTransparentFocusSeparateFromVisibleControlColors(t *testing.T) {
	for _, tc := range []struct{ id, accent, thumb string }{
		{"vitesse-light", "#1c6b48", "#393a34"},
		{"vitesse-dark", "#4d9375", "#dbd7caee"},
	} {
		start := strings.Index(themePalettesCSS, `:root:has(body[data-color-theme="`+tc.id+`"]`)
		if start < 0 {
			t.Fatalf("missing palette: %s", tc.id)
		}
		palette := strings.SplitN(themePalettesCSS[start:], "}", 2)[0]
		for _, want := range []string{
			"--vscode-focusBorder: #00000000;",
			"--vscode-button-background: " + tc.accent + ";",
			"--vscode-checkbox-foreground: " + tc.thumb + ";",
		} {
			if !strings.Contains(palette, want) {
				t.Fatalf("%s must preserve focus and resolve visible control colors: missing %s", tc.id, want)
			}
		}
	}
}

func TestMissingLinkColorsUseTheSelectedPaletteAccent(t *testing.T) {
	for _, tc := range []struct{ id, link string }{
		{"solarized-dark", "#2AA198"},
		{"solarized-light", "#b49471"},
		{"one-dark", "#528BFF"},
		{"one-light", "#526FFF"},
		{"github-dark", "#79b8ff"},
		{"vitesse-dark", "#4d9375"},
	} {
		start := strings.Index(themePalettesCSS, `:root:has(body[data-color-theme="`+tc.id+`"]`)
		if start < 0 {
			t.Fatalf("missing palette: %s", tc.id)
		}
		palette := strings.SplitN(themePalettesCSS[start:], "}", 2)[0]
		if !strings.Contains(palette, "--vscode-textLink-foreground: "+tc.link+";") {
			t.Fatalf("%s must use its own accent for links and active project icons", tc.id)
		}
	}
}

func TestThemeSemanticFallbacksDoNotInheritDefaultColors(t *testing.T) {
	for _, tc := range []struct{ id, key, want string }{
		{"one-dark", "gitDecoration-addedResourceForeground", "#98C379"},
		{"one-dark", "gitDecoration-deletedResourceForeground", "#E06C75"},
		{"solarized-dark", "editorWarning-foreground", "#b58900"},
		{"pierre-dark", "errorForeground", "#ff2e3f"},
		{"vitesse-dark", "editorWarning-foreground", "#d4976c"},
	} {
		start := strings.Index(themePalettesCSS, `:root:has(body[data-color-theme="`+tc.id+`"]`)
		if start < 0 {
			t.Fatalf("missing palette: %s", tc.id)
		}
		palette := strings.SplitN(themePalettesCSS[start:], "}", 2)[0]
		if !strings.Contains(palette, "--vscode-"+tc.key+": "+tc.want+";") {
			t.Fatalf("%s must use its own %s color", tc.id, tc.key)
		}
	}
}

func TestPluginControlsHaveResolvedColorsForEveryBuiltInPalette(t *testing.T) {
	for _, family := range codeThemeCatalog {
		for _, id := range []string{family.Light, family.Dark} {
			start := strings.Index(themePalettesCSS, `:root:has(body[data-color-theme="`+id+`"]`)
			if start < 0 {
				t.Fatalf("missing palette: %s", id)
			}
			palette := strings.SplitN(themePalettesCSS[start:], "}", 2)[0]
			for _, key := range []string{
				"menu-background", "menu-foreground", "menu-border", "menu-selectionBackground", "menu-selectionForeground",
				"input-placeholderForeground", "inputOption-activeBorder", "progressBar-background", "toolbar-hoverBackground",
				"textPreformat-background", "textPreformat-foreground", "chat-slashCommandBackground", "chat-slashCommandForeground",
				"errorForeground", "editorWarning-foreground", "gitDecoration-addedResourceForeground", "gitDecoration-deletedResourceForeground",
				"editor-lineHighlightBackground",
				"terminal-ansiRed", "terminal-ansiGreen", "terminal-ansiBlue", "terminal-ansiCyan", "terminal-ansiMagenta",
				"charts-red", "charts-green", "charts-blue", "charts-purple", "charts-orange", "charts-yellow",
			} {
				if !strings.Contains(palette, "--vscode-"+key+": ") {
					t.Fatalf("%s must resolve %s rather than inherit Default", id, key)
				}
			}
		}
	}
}
