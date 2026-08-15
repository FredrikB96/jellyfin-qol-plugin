# Build and install — Jellyfin QoL Plugin final settings v2

## Build

Requires .NET SDK 9 and Jellyfin Server 10.11.8-compatible package references.

```powershell
dotnet restore .\Jellyfin.Plugin.QoL\Jellyfin.Plugin.QoL.csproj
dotnet publish .\Jellyfin.Plugin.QoL\Jellyfin.Plugin.QoL.csproj -c Release
```

Output:

`Jellyfin.Plugin.QoL/bin/Release/net9.0/publish/Jellyfin.Plugin.QoL.dll`

## Manual Docker install for development

```bash
docker exec jellyfin mkdir -p "/config/plugins/Jellyfin QoL Plugin"
```

Copy the built DLL from the build machine:

```bash
docker cp ./Jellyfin.Plugin.QoL/bin/Release/net9.0/publish/Jellyfin.Plugin.QoL.dll \
  "jellyfin:/config/plugins/Jellyfin QoL Plugin/Jellyfin.Plugin.QoL.dll"

docker restart jellyfin
```

## Required client bootstrap host

Install and enable at least one of these plugins before restarting Jellyfin:

- File Transformation (preferred)
- JavaScript Injector

Jellyfin QoL discovers the installed host at server startup and registers its
embedded client bootstrap through that host's plugin API. If both are present,
File Transformation is used and any QoL-owned JavaScript Injector registration
is removed. Users never paste or maintain a loader script.

The active host is shown under:

`Dashboard -> Plugins -> My Plugins -> Jellyfin QoL Plugin -> Settings`

## Settings split

Administrator/global settings:

`Dashboard -> Plugins -> My Plugins -> Jellyfin QoL Plugin`

User settings:

`Profile -> Settings -> QoL Settings`

## Prototype scripts

All navigation, settings UI, per-user API, persistence and client runtime modules
are embedded in the DLL. Disable and remove the old prototype scripts, including
the temporary DLL loader, after the automatic bootstrap host reports active.
