package server

import "regexp"

// Keep the original dialog and session binding; expose only its open callback.
var contextDialogPattern = regexp.MustCompile(`openContextDialog:(\(\)=>[A-Za-z_$][A-Za-z0-9_$]*\(!0\))`)

func patchContextAdapter(source string) (string, bool) {
	if len(contextDialogPattern.FindAllStringIndex(source, -1)) != 1 {
		return source, false
	}
	return contextDialogPattern.ReplaceAllString(source, `openContextDialog:window.__goContext.attach($1)`), true
}
