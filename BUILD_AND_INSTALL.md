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

## Settings split

Administrator/global settings:

`Dashboard -> Plugins -> My Plugins -> Jellyfin QoL Plugin`

User settings:

`Profile -> Settings -> QoL Settings`

During development the user settings entry is loaded by the tiny script:

`dev/Load_DLL_User_Settings_Bridge.js`

Load only that file through JavaScript Injector. The actual settings UI,
per-user API, and persistence are embedded in the DLL.

## Prototype scripts

Disable the old injected settings UI/services. Keep the navigation runtime
modules that are still being migrated.

The temporary development bridge may call existing prototype runtime functions
where they exist. Unimplemented functionality prints `[STUB]` messages instead
of pretending to be complete.
