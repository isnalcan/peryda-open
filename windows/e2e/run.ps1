# 1) Installs the freshly built installer silently (current user) and checks the installed app starts
#    and keeps running. 2) Runs the smoke test against a test build of the same app whose WebView2
#    DevTools port is open (the installed app never opens it).
$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem windows/src-tauri/target/release/bundle/nsis/*.exe | Select-Object -First 1
Write-Host "Installing $($installer.Name)"
Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
$dir = Join-Path $env:LOCALAPPDATA 'Peryda'
$installed = Get-ChildItem $dir -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'uninstall' } | Select-Object -First 1
if (-not $installed) { throw 'Installed app not found' }
Write-Host "Installed: $($installed.FullName)"
$p = Start-Process -FilePath $installed.FullName -PassThru
Start-Sleep -Seconds 12
$p.Refresh()
if ($p.HasExited) { throw "Installed app exited with code $($p.ExitCode)" }
$views = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count
Write-Host "Installed app is running (WebView2 processes: $views)"
Stop-Process -Id $p.Id -Force
Start-Sleep -Seconds 2

$test = Resolve-Path windows/src-tauri/target-e2e/release/peryda-windows.exe
Write-Host "Smoke test with $test"
node windows/e2e/smoke.mjs $test
exit $LASTEXITCODE
