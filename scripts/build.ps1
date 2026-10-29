param([ValidateSet('amd64', 'arm64')][string]$Arch = 'amd64')
$ErrorActionPreference = 'Stop'
# Compatibility entry point only. npm run build invokes Node directly.
& node "$PSScriptRoot/build.cjs" --platform windows --arch $Arch
exit $LASTEXITCODE
