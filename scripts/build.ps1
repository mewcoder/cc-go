param([ValidateSet('amd64', 'arm64')][string]$Arch = 'amd64')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$LocalGo = Join-Path $Root '.tools/go/bin/go.exe'
$Go = if (Test-Path $LocalGo) { $LocalGo } else { 'go' }
$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$Name = "cc-go-$Version-windows-$Arch"
$Stage = Join-Path $Root "build/$Name"
$ResourcePrefix = Join-Path $Root 'cmd/cc-go/resource'
$OldOS, $OldArch, $OldCGO = $env:GOOS, $env:GOARCH, $env:CGO_ENABLED
New-Item -ItemType Directory -Force "$Stage/node_modules", 'release' | Out-Null
try {
    # The resource generator runs on the build host before selecting the target.
    $env:GOOS = $null
    $env:GOARCH = $null
    & $Go run github.com/tc-hib/go-winres@v0.3.3 simply --arch $Arch --out $ResourcePrefix --manifest gui --icon assets/icon.ico --product-name 'CC Go' --file-description 'Claude Code VS Code extension (.vsix) desktop host' --original-filename 'cc-go.exe' --product-version $Version --file-version $Version
    if ($LASTEXITCODE -ne 0) { throw 'Windows icon/manifest generation failed' }
    $env:GOOS = 'windows'
    $env:GOARCH = $Arch
    $env:CGO_ENABLED = '0'
    & $Go build -trimpath '-ldflags=-s -w -H=windowsgui' -o "$Stage/cc-go.exe" ./cmd/cc-go
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
    Copy-Item -Path @('node_modules/picomatch', 'node_modules/vscode-uri') -Destination "$Stage/node_modules/" -Recurse -Force
    Copy-Item README.md "$Stage/README.md"
    $Archive = Join-Path $Root "release/$Name.zip"
    Compress-Archive -Path $Stage -DestinationPath $Archive -Force
    $Hash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    "$Hash  $Name.zip" | Set-Content "$Archive.sha256" -Encoding ASCII
    Write-Host "Built: $Archive (requires local Node.js 22+ and Microsoft Edge WebView2 Runtime)"
} finally {
    Remove-Item "${ResourcePrefix}_windows_$Arch.syso" -ErrorAction SilentlyContinue
    $env:GOOS, $env:GOARCH, $env:CGO_ENABLED = $OldOS, $OldArch, $OldCGO
}
