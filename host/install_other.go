//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func nmDirs() []string {
	home, _ := os.UserHomeDir()
	var rel []string
	if runtime.GOOS == "darwin" {
		b := filepath.Join(home, "Library", "Application Support")
		rel = []string{"Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Yandex/YandexBrowser", "Vivaldi"}
		for i, r := range rel {
			rel[i] = filepath.Join(b, r, "NativeMessagingHosts")
		}
		return rel
	}
	b := filepath.Join(home, ".config")
	rel = []string{"google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser", "yandex-browser", "vivaldi"}
	for i, r := range rel {
		rel[i] = filepath.Join(b, r, "NativeMessagingHosts")
	}
	return rel
}

func registerHost(_ string, manifest []byte) (int, error) {
	n := 0
	for _, d := range nmDirs() {
		// пишем только туда, где браузер уже есть
		if _, err := os.Stat(filepath.Dir(d)); err != nil {
			continue
		}
		if err := os.MkdirAll(d, 0o755); err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(d, hostName+".json"), manifest, 0o644); err == nil {
			n++
		}
	}
	if n == 0 {
		return 0, fmt.Errorf("не найден ни один поддерживаемый браузер")
	}
	return n, nil
}

func unregisterHost() {
	for _, d := range nmDirs() {
		_ = os.Remove(filepath.Join(d, hostName+".json"))
	}
}

func removeDir(dir string) { _ = os.RemoveAll(dir) }

func openFolder(p string) {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", p).Start()
	}
}

func report(msg string, err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "Ошибка:", err)
		os.Exit(1)
	}
	fmt.Println(msg)
}
