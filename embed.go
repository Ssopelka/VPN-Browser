// Package app вшивает папку расширения в исполняемый файл установщика.
package app

import "embed"

//go:embed all:extension
var Extension embed.FS
