package runtimefiles

import "embed"

//go:embed *.cjs *.css
var Files embed.FS
