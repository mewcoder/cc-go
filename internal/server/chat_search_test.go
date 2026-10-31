package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatSearchIsServedAndLoadedAfterDesktopAndProjectMenu(t *testing.T) {
	a := testApp(t)
	page := httptest.NewRecorder()
	a.Handler().ServeHTTP(page, httptest.NewRequest("GET", a.ShellURL+"/", nil))
	html := page.Body.String()
	search := strings.Index(html, `<script src="chat-search.js" defer></script>`)
	if page.Code != http.StatusOK || search < 0 || search < strings.Index(html, `src="desktop.js"`) ||
		search < strings.Index(html, `src="history.js"`) || search > strings.Index(html, `src="shell.js"`) {
		t.Fatal("chat search must load after desktop and the project menu, before the shell starts delivering state")
	}
	script := httptest.NewRecorder()
	a.Handler().ServeHTTP(script, httptest.NewRequest("GET", a.ShellURL+"/chat-search.js", nil))
	if script.Code != http.StatusOK || !strings.Contains(script.Header().Get("Content-Type"), "javascript") ||
		!strings.Contains(script.Body.String(), "'search-chats'") {
		t.Fatal("chat search entry point must be served as JavaScript")
	}
}
