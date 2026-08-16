param(
    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$Project = Join-Path $PSScriptRoot "..\Jellyfin.Plugin.QoL\Jellyfin.Plugin.QoL.csproj"
$ProjectDocument = [xml](Get-Content -Raw -LiteralPath $Project)
if (-not $Version) {
    $Version = [string]$ProjectDocument.Project.PropertyGroup.Version
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "Version must contain four numeric parts, for example 1.0.1.0."
}

$Out = Join-Path $PSScriptRoot "..\artifacts\JellyfinQoL-$Version"
$Zip = Join-Path $PSScriptRoot "..\artifacts\JellyfinQoL-$Version.zip"
Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Out -Force | Out-Null
dotnet publish $Project -c Release -o $Out `
    -p:Version=$Version `
    -p:FileVersion=$Version `
    -p:AssemblyVersion=$Version
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE."
}
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$Out\Jellyfin.Plugin.QoL.dll" -DestinationPath $Zip
$Hash = (Get-FileHash $Zip -Algorithm MD5).Hash.ToLowerInvariant()
Write-Host "Release: $Zip"
Write-Host "Manifest checksum (MD5): $Hash"
