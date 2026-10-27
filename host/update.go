package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	releaseAPI = "https://api.github.com/repos/Ssopelka/VPN-Browser/releases/latest"
	maxBinary  = 200 << 20
)

// Файлы релиза скачиваются только с этого адреса.
var releaseDL = "https://github.com/Ssopelka/VPN-Browser/releases/download/"

var errUpToDate = errors.New("установлена последняя версия")

type ghRelease struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func assetName() string {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return "VPN-Terminal-Setup-windows-x64.exe"
	case "windows/arm64":
		return "VPN-Terminal-Setup-windows-arm64.exe"
	case "linux/amd64":
		return "vpn-terminal-linux-x64"
	case "darwin/arm64":
		return "vpn-terminal-macos-arm64"
	case "darwin/amd64":
		return "vpn-terminal-macos-x64"
	}
	return ""
}

func versionParts(v string) []int {
	var out []int
	for _, p := range strings.Split(strings.TrimPrefix(v, "v"), ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func isNewer(latest, current string) bool {
	a, b := versionParts(latest), versionParts(current)
	if a == nil || b == nil {
		return false
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func httpGet(url string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json, application/octet-stream, text/plain")
	req.Header.Set("User-Agent", "vpn-terminal/"+version)
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("GitHub ответил: %s", resp.Status)
	}
	return resp, nil
}

func latestRelease() (*ghRelease, error) {
	resp, err := httpGet(releaseAPI, 20*time.Second)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&r); err != nil {
		return nil, err
	}
	if r.Tag == "" {
		return nil, errors.New("в ответе GitHub нет версии")
	}
	return &r, nil
}

func checkUpdate() (latest string, newer bool, err error) {
	r, err := latestRelease()
	if err != nil {
		return "", false, err
	}
	return r.Tag, version != "dev" && isNewer(r.Tag, version), nil
}

// parseSums достаёт хеш файла из SHA256SUMS.txt (формат sha256sum).
func parseSums(text, name string) string {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name && len(f[0]) == 64 {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

func downloadVerified(url, dst, want string) error {
	if !strings.HasPrefix(url, releaseDL) {
		return errors.New("неожиданный адрес загрузки")
	}
	resp, err := httpGet(url, 10*time.Minute)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxBinary+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > maxBinary {
		err = errors.New("файл слишком большой")
	}
	if err == nil && hex.EncodeToString(h.Sum(nil)) != want {
		err = errors.New("контрольная сумма не совпала")
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}

// applyUpdate скачивает последний релиз, проверяет SHA-256 и запускает новый файл с командой setup.
func applyUpdate(progress func(string)) (string, error) {
	if version == "dev" {
		return "", errors.New("сборка для разработки не обновляется")
	}
	dir, err := installDir()
	if err != nil {
		return "", err
	}
	self, _ := os.Executable()
	if a, _ := filepath.EvalSymlinks(self); a != filepath.Join(dir, exeName()) {
		return "", errors.New("хост запущен не из каталога установки")
	}
	progress("Проверка версии…")
	rel, err := latestRelease()
	if err != nil {
		return "", err
	}
	if !isNewer(rel.Tag, version) {
		return rel.Tag, errUpToDate
	}
	name := assetName()
	if name == "" {
		return "", errors.New("для этой платформы нет сборки")
	}
	var binURL, sumsURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case name:
			binURL = a.URL
		case "SHA256SUMS.txt":
			sumsURL = a.URL
		}
	}
	if binURL == "" || sumsURL == "" {
		return "", errors.New("в релизе нет нужных файлов")
	}
	resp, err := httpGet(sumsURL, 20*time.Second)
	if err != nil {
		return "", err
	}
	sums, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if err != nil {
		return "", err
	}
	want := parseSums(string(sums), name)
	if want == "" {
		return "", errors.New("в SHA256SUMS.txt нет нужного файла")
	}
	dl := filepath.Join(dir, "update-"+rel.Tag+filepath.Ext(exeName()))
	progress("Загрузка " + rel.Tag + "…")
	if err := downloadVerified(binURL, dl, want); err != nil {
		return "", err
	}
	progress("Установка…")
	if v, err := exec.Command(dl, "version").Output(); err != nil || strings.TrimSpace(string(v)) != rel.Tag {
		os.Remove(dl)
		return "", errors.New("загруженный файл не прошёл проверку версии")
	}
	out, err := exec.Command(dl, "setup").CombinedOutput()
	os.Remove(dl)
	if err != nil {
		return "", fmt.Errorf("установка: %w %s", err, strings.TrimSpace(string(out)))
	}
	return rel.Tag, nil
}

func updateCLI() (string, error) {
	tag, err := applyUpdate(func(string) {})
	if errors.Is(err, errUpToDate) {
		return "Установлена последняя версия: " + tag, nil
	}
	if err != nil {
		return "", err
	}
	return "Обновлено до " + tag + ". Перезапустите расширение в браузере.", nil
}
