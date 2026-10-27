//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Только HKCU — права администратора не нужны.
var regBases = []string{
	`Software\Yandex\YandexBrowser`,
	`Software\Google\Chrome`,
	`Software\Microsoft\Edge`,
	`Software\BraveSoftware\Brave-Browser`,
	`Software\Chromium`,
}

func registerHost(manifestPath string, _ []byte) (int, error) {
	n := 0
	for _, b := range regBases {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, b+`\NativeMessagingHosts\`+hostName, registry.SET_VALUE)
		if err != nil {
			continue
		}
		if k.SetStringValue("", manifestPath) == nil {
			n++
		}
		k.Close()
	}
	if n == 0 {
		return 0, fmt.Errorf("не удалось записать в реестр")
	}
	return n, nil
}

func unregisterHost() {
	for _, b := range regBases {
		_ = registry.DeleteKey(registry.CURRENT_USER, b+`\NativeMessagingHosts\`+hostName)
	}
}

// exe запущен — удалить его самого нельзя, поэтому добиваем каталог отдельной командой после выхода.
func removeDir(dir string) {
	cmd := exec.Command("cmd", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+dir+"\"")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	_ = cmd.Start()
}

func openFolder(p string) { _ = exec.Command("explorer.exe", filepath.Clean(p)).Start() }

// Сборка с -H=windowsgui (без консоли, чтобы хост не мигал окном), поэтому результат показываем окном.
func report(msg string, err error) {
	title, text := "VPN Terminal", msg
	if err != nil {
		title, text = "VPN Terminal — ошибка", err.Error()
	}
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x40)
	if err != nil {
		os.Exit(1)
	}
}
