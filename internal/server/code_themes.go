package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	runtimefiles "cc-go/runtime"
)

type codeThemeInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Light string `json:"light"`
	Dark  string `json:"dark"`
}

var validPaletteColor = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

var codeThemeCatalog = func() []codeThemeInfo {
	b, err := runtimefiles.Files.ReadFile("code-themes/catalog.json")
	if err != nil {
		panic(err)
	}
	var themes []codeThemeInfo
	if err := json.Unmarshal(b, &themes); err != nil {
		panic(err)
	}
	return themes
}()

func codeThemeSelection(id string) codeThemeInfo {
	for _, theme := range codeThemeCatalog {
		if theme.ID == id {
			return theme
		}
	}
	return codeThemeInfo{ID: "default", Label: "Default", Light: "default", Dark: "default"}
}

func validCodeTheme(id string) bool {
	return id == "default" || codeThemeSelection(id).ID == id
}

func validCodePalette(id string) bool {
	for _, theme := range codeThemeCatalog {
		if theme.Light == id || theme.Dark == id {
			return true
		}
	}
	return false
}

func serveCodeTheme(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSuffix(name, ".json")
	if name != "catalog.json" && (name != id+".json" || id == "default" || !validCodePalette(id)) {
		http.NotFound(w, r)
		return
	}
	b, err := runtimefiles.Files.ReadFile("code-themes/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != "HEAD" {
		_, _ = w.Write(b)
	}
}

// The VSIX keeps Monaco inside its bundle. Expose only its theme adapter and
// resolve palette names at the existing theme-kind boundary, without editing it on disk.
var monacoAttachPattern = regexp.MustCompile(`setTheme:([A-Za-z_$][A-Za-z0-9_$]*)\.setTheme,languages:`)
var monacoKindPattern = regexp.MustCompile(`if\(([A-Za-z_$][A-Za-z0-9_$]*)\.contains\("vscode-light"\)\)return"vs";return"vs-dark"`)

func patchCodeThemeAdapter(source string) (string, bool) {
	if len(monacoAttachPattern.FindAllStringIndex(source, -1)) != 1 || len(monacoKindPattern.FindAllStringIndex(source, -1)) != 1 {
		return source, false
	}
	source = monacoAttachPattern.ReplaceAllString(source, `setTheme:window.__goCodeThemes.attach($1),languages:`)
	source = monacoKindPattern.ReplaceAllString(source, `if($1.contains("vscode-light"))return window.__goCodeThemes.resolve("vs");return window.__goCodeThemes.resolve("vs-dark")`)
	return source, true
}
