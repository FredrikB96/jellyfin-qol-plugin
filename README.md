<p align="center">
  <img src="repository/jellyfin-qol-logo.png" alt="Jellyfin QoL" width="180">
</p>

<h1 align="center">Jellyfin QoL Plugin</h1>

<p align="center">
  Controller-independent navigation and quality-of-life controls for Jellyfin Web and Jellyfin Media Player.
</p>

## Features

- Directional Air Navigation across home, library, details, settings, modal, and form surfaces.
- Media-card scrolling that keeps the selected artwork in view.
- Player ownership switching: Jellyfin keeps native seek/volume keys until AirNav control mode is enabled with `F6`.
- Navigable quick actions, item actions, dropdowns, checkboxes, and plugin settings.
- Per-user settings, client-local device enrollment, remappable inputs, and profiles.
- Automatic client bootstrap registration through a supported host plugin—no pasted loader script.

## Requirements

- Jellyfin Server `10.11.8`.
- Either **File Transformation** (preferred) or **JavaScript Injector** installed and enabled.
- A Jellyfin Web client or Jellyfin Media Player. Other native clients are outside the plugin's scope.

## Install from the Jellyfin repository

1. Open `Dashboard -> Plugins -> Repositories`.
2. Add a repository named `Jellyfin QoL` with this URL:

   ```text
   https://raw.githubusercontent.com/FredrikB96/jellyfin-qol-plugin/refs/heads/Main/repository/manifest.json
   ```

3. Open the plugin catalog, find **Jellyfin QoL Plugin** under **General**, and install it.
4. Restart Jellyfin.
5. Confirm the bootstrap host under `Dashboard -> Plugins -> My Plugins -> Jellyfin QoL Plugin`.
6. Enable Air Navigation for each browser/media-player device that should use it.

The repository and release assets must be publicly reachable for repository installation to work.

## Settings

- Administrator defaults: `Dashboard -> Plugins -> My Plugins -> Jellyfin QoL Plugin`.
- User settings: `Profile -> Settings -> QoL Settings`.
- Device enrollment, optional helper, and HTPC state stay local to each client.

## Development

See [BUILD_AND_INSTALL.md](BUILD_AND_INSTALL.md), [SETTINGS_ARCHITECTURE.md](SETTINGS_ARCHITECTURE.md), and [GITHUB_SETUP.md](GITHUB_SETUP.md).

All runtime modules and user-interface resources are embedded in the plugin DLL. Remove the old prototype scripts and temporary DLL loader after the automatic bootstrap host reports active.

## License

Jellyfin QoL Plugin is available under the [MIT License](LICENSE).
