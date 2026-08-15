# Jellyfin QoL Plugin

Jellyfin Web/HTPC quality-of-life features and controller-independent Air
Navigation, distributed as a normal Jellyfin repository plugin.

## Requirement

Install and enable either **File Transformation** (preferred) or **JavaScript
Injector**. Jellyfin QoL registers its embedded client bootstrap through the
available plugin API; no script needs to be copied or pasted.

- Global/admin defaults live in the standard Jellyfin plugin settings page.
- Per-user QoL settings live in Profile -> Settings -> QoL Settings.
- User settings are stored separately per authenticated Jellyfin user.
- Device enrollment/helper/HTPC state stays client-local.
- User settings use one vertically-scrolling page with sections, not a tab bar.
- The browser runtime and user-settings bridge are embedded in the plugin DLL.

See `SETTINGS_ARCHITECTURE.md` and `BUILD_AND_INSTALL.md`.


## v2.2 native user-settings layout

The user QoL page is mounted as a normal Jellyfin preference page rather than a fixed modal overlay. It uses Jellyfin's native `settingsContainer`, `verticalSection`, `sectionTitle`, form-control and full-width save-button classes. Custom CSS is limited to QoL-only structures such as the keybind table and protected-input grid.
