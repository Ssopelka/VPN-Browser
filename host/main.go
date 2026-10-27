package main

import (
	"fmt"
	"os"
	"strings"
)

var version = "dev"

// ID расширения задаётся полем key в manifest.json.
const extID = "aakkclmhpdfjajdbclhfaeodkbfpnakj"
const hostName = "net.stealthsurf.vpn_host"

func main() {
	args := os.Args[1:]
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			if a != "chrome-extension://"+extID+"/" {
				fmt.Fprintln(os.Stderr, "неизвестное расширение:", a)
				os.Exit(2)
			}
			runHost()
			return
		}
	}
	cmd := "install"
	if len(args) > 0 {
		cmd = strings.TrimLeft(args[0], "-/")
	}
	switch cmd {
	case "install":
		report(install())
	case "uninstall", "remove":
		report(uninstall())
	case "version":
		fmt.Println(version)
	default:
		fmt.Println("VPN Terminal " + version + "\n\nvpn-terminal install    — установить (по умолчанию при двойном клике)\nvpn-terminal uninstall  — удалить")
	}
}
