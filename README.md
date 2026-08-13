# Jellyfin QoL Plugin

Final-plugin migration build focused on the permanent settings architecture.

- Global/admin defaults live in the standard Jellyfin plugin settings page.
- Per-user QoL settings live in Profile -> Settings -> QoL Settings.
- User settings are stored separately per authenticated Jellyfin user.
- Device enrollment/helper/HTPC state stays client-local.
- User settings use one vertically-scrolling page with sections, not a tab bar.
- Existing prototype AirNav runtime may remain injected while runtime modules are migrated.
- Functions not implemented in the final runtime yet intentionally log `[STUB]`.

See `SETTINGS_ARCHITECTURE.md` and `BUILD_AND_INSTALL.md`.


## v2.2 native user-settings layout

The user QoL page is mounted as a normal Jellyfin preference page rather than a fixed modal overlay. It uses Jellyfin's native `settingsContainer`, `verticalSection`, `sectionTitle`, form-control and full-width save-button classes. Custom CSS is limited to QoL-only structures such as the keybind table and protected-input grid.
