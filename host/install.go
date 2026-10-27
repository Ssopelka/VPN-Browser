package main

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	app "github.com/Ssopelka/VPN-Browser"
)

// installDir — каталог установки: сюда копируются exe, манифест хоста и папка extension.
func installDir() (string, error) {
	base, err := os.UserConfigDir() // %AppData% / ~/.config / ~/Library/Application Support
	if err != nil {
		return "", err
	}
	if lad := os.Getenv("LOCALAPPDATA"); lad != "" {
		base = lad
	}
	return filepath.Join(base, "VPN Terminal"), nil
}

func exeName() string {
	if filepath.Ext(os.Args[0]) == ".exe" || os.PathSeparator == '\\' {
		return "vpn-terminal.exe"
	}
	return "vpn-terminal"
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	// запущенный exe на Windows нельзя перезаписать, но можно переименовать
	_ = os.Remove(dst + ".old")
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, dst+".old"); err != nil {
			return err
		}
	}
	return os.Rename(tmp, dst)
}

func extractExtension(dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	return fs.WalkDir(app.Extension, "extension", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel("extension", p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := app.Extension.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

func hostManifest(exePath string) ([]byte, error) {
	return json.MarshalIndent(map[string]any{
		"name":            hostName,
		"description":     "VPN Terminal host",
		"path":            exePath,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + extID + "/"},
	}, "", "  ")
}

func install() (string, error) {
	dir, err := installDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe := filepath.Join(dir, exeName())
	if a, _ := filepath.EvalSymlinks(self); a != exe {
		if err := copyFile(self, exe); err != nil {
			return "", fmt.Errorf("копирование: %w", err)
		}
	}
	extDir := filepath.Join(dir, "extension")
	if err := extractExtension(extDir); err != nil {
		return "", fmt.Errorf("распаковка расширения: %w", err)
	}
	mf, _ := hostManifest(exe)
	mfPath := filepath.Join(dir, hostName+".json")
	if err := os.WriteFile(mfPath, mf, 0o644); err != nil {
		return "", err
	}
	n, err := registerHost(mfPath, mf)
	if err != nil {
		return "", err
	}
	openFolder(extDir)
	return fmt.Sprintf("Готово (браузеров: %d).\n\nОткройте browser://extensions, включите «Режим разработчика», нажмите «Загрузить распакованное расширение» и выберите папку:\n%s", n, extDir), nil
}

func uninstall() (string, error) {
	dir, err := installDir()
	if err != nil {
		return "", err
	}
	unregisterHost()
	removeDir(dir)
	return "Хост удалён. Осталось удалить само расширение: browser://extensions → VPN Terminal → Удалить.", nil
}
