# Jellyfin QoL Settings Architecture — Final Plugin v2

## Administrator / global settings

Location:

`Dashboard -> Plugins -> My Plugins -> Jellyfin QoL Plugin -> Settings`

Owned by `PluginConfiguration.SettingsJson` and therefore server-global.

Contains only defaults / administrator settings:
- General defaults
- Input and gesture defaults
- Navigation defaults
- Focus and scrolling defaults
- Player defaults
- Global debug / diagnostics

No per-user profile or client-local helper/HTPC configuration is stored here.

## User settings

Intended location:

`Profile -> Settings -> QoL Settings`

The page is embedded in the DLL as `Web/userSettingsPage.html` +
`Web/userSettingsPage.js` and is mounted by `Web/userSettingsBridge.js`.

The page is deliberately ONE page, not a tab bar. Sections are ordered by
expected frequency of use:

1. General
2. Inputs & Profiles
3. Navigation
4. Focus & Scrolling
5. Player
6. Search & Forms
7. Windows Helper & HTPC
8. Advanced & Diagnostics

Per-user settings are stored by the authenticated API:

- `GET /JellyfinQoL/UserSettings`
- `PUT /JellyfinQoL/UserSettings`
- `DELETE /JellyfinQoL/UserSettings`

The server derives the user id from the authenticated request. The browser does
not send a target user id.

## Client-local settings

These remain in the individual browser/WebView profile:
- AirNav enabled on this device
- Active profile on this device
- Mouse/touch focus behavior
- Windows helper enabled + localhost URL
- Protected-input helper registry cache
- HTPC exit behavior

## Client bootstrap hosting

Jellyfin 10.11's plugin configuration page list is administrator-gated. The
final user page therefore uses an embedded client bridge to insert the QoL
Settings entry into the normal user preferences page.

At server startup the DLL automatically registers its small bootstrap loader
through File Transformation or JavaScript Injector. File Transformation is
preferred when both are enabled. The registration is plugin-owned and
idempotent; users do not paste JavaScript or maintain a custom loader entry.

If neither host can be registered, the server logs an explicit error and the
admin plugin page reports that the client runtime is inactive.
