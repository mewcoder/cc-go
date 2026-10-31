//go:build !headless

package desktop

import (
	"context"
	"encoding/json"
	"errors"

	"cc-go/internal/server"
	"github.com/egoist/mygo"
)

// ViewBridge is deliberately narrow: only the trusted shell can relay messages
// for a token-authorized view. Do not bind the whole backend or preload iframes.
type ViewBridge struct{ backend *server.App }

func (b *ViewBridge) trusted(ctx context.Context) bool {
	page := mygo.CallerPage(ctx)
	return page != nil && sameOrigin(page.URL(), b.backend.ShellURL)
}

func (b *ViewBridge) Stream(ctx context.Context, id, token string, output *mygo.Channel[json.RawMessage]) error {
	if !b.trusted(ctx) {
		return errors.New("untrusted view bridge caller")
	}
	return b.backend.StreamNativeView(ctx, id, token, output.Send, output.Close)
}

func (b *ViewBridge) Post(ctx context.Context, id, token, endpoint string, value json.RawMessage) error {
	if !b.trusted(ctx) {
		return errors.New("untrusted view bridge caller")
	}
	return b.backend.ReceiveNativeView(id, token, endpoint, value)
}
