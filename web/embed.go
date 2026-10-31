package webfiles

import "embed"

//go:embed *.html *.js *.css vendor
var Files embed.FS
