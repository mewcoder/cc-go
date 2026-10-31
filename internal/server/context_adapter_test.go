package server

import (
	"strings"
	"testing"
)

func TestContextDialogAdapter(t *testing.T) {
	const source = `openUsageDialog:()=>J.executeCommand("account-usage"),openContextDialog:()=>e5(!0),submit:x=>c1(x)`
	patched, ok := patchContextAdapter(source)
	if !ok || !strings.Contains(patched, `openContextDialog:window.__goContext.attach(()=>e5(!0))`) {
		t.Fatal("did not expose the original context dialog callback")
	}
	for _, unsupported := range []string{"unrelated", source + source, `openContextDialog:()=>submit("/context")`} {
		patched, ok := patchContextAdapter(unsupported)
		if ok || patched != unsupported {
			t.Fatal("must leave unsupported or ambiguous bundles unchanged")
		}
	}
}
