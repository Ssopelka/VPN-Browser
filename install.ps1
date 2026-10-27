# Регистрирует хост для Яндекс Браузера, Chrome и Edge (только для текущего пользователя, без прав администратора).
$ErrorActionPreference = 'Stop'
$Name = 'net.stealthsurf.vpn_host'
$ExtId = 'aakkclmhpdfjajdbclhfaeodkbfpnakj'
$HostDir = Join-Path $PSScriptRoot 'host'
$Manifest = Join-Path $HostDir "$Name.json"

$json = ConvertTo-Json -Depth 5 ([ordered]@{
    name            = $Name
    description     = 'VPN Terminal host'
    path            = (Join-Path $HostDir 'host.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
})
[IO.File]::WriteAllText($Manifest, $json, (New-Object System.Text.UTF8Encoding($false)))

foreach ($base in 'Software\Yandex\YandexBrowser', 'Software\Google\Chrome', 'Software\Microsoft\Edge') {
    $key = "HKCU:\$base\NativeMessagingHosts\$Name"
    $null = New-Item -Path $key -Value $Manifest -Force
    Write-Host "OK: $base"
}
Write-Host ''
Write-Host 'Готово. Теперь загрузите папку extension в browser://extensions (режим разработчика).'
