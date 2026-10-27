# Удаляет всё, что создал install.bat и хост: записи реестра, ядро sing-box, конфиги.
$ErrorActionPreference = 'SilentlyContinue'
$Name = 'net.stealthsurf.vpn_host'
$HostDir = Join-Path $PSScriptRoot 'host'
$Core = Join-Path $HostDir 'bin\sing-box.exe'

# остановить ядро, запущенное из этой папки
Get-Process sing-box | Where-Object { $_.Path -eq $Core } | Stop-Process -Force
Start-Sleep -Milliseconds 500

foreach ($base in 'Software\Yandex\YandexBrowser', 'Software\Google\Chrome', 'Software\Microsoft\Edge') {
    Remove-Item -Path "HKCU:\$base\NativeMessagingHosts\$Name" -Recurse -Force
    Write-Host "Реестр очищен: $base"
}

Remove-Item -Path (Join-Path $HostDir 'bin') -Recurse -Force
Remove-Item -Path (Join-Path $HostDir 'core-config.json') -Force
Remove-Item -Path (Join-Path $HostDir "$Name.json") -Force
Write-Host 'Ядро и конфиги удалены.'

Write-Host ''
Write-Host 'Осталось удалить само расширение: browser://extensions -> VPN Terminal -> Удалить.'
Write-Host 'После этого настройки прокси в браузере сбросятся автоматически.'
