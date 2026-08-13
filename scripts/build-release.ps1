$ErrorActionPreference = "Stop"
$Project = Join-Path $PSScriptRoot "..\Jellyfin.Plugin.QoL\Jellyfin.Plugin.QoL.csproj"
$Out = Join-Path $PSScriptRoot "..\artifacts\JellyfinQoL-1.0.0.0"
$Zip = Join-Path $PSScriptRoot "..\artifacts\JellyfinQoL-1.0.0.0.zip"
Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Out -Force | Out-Null
dotnet publish $Project -c Release -o $Out
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$Out\*" -DestinationPath $Zip
$Hash = (Get-FileHash $Zip -Algorithm MD5).Hash.ToLowerInvariant()
Write-Host "Release: $Zip"
Write-Host "Manifest checksum (MD5): $Hash"
