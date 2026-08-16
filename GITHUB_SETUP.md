# GitHub development and release setup

Repository: `FredrikB96/jellyfin-qol-plugin`.

## Branches

- `Main`: stable, releasable source and the repository's default branch.
- `dev`: active development. Every push builds and deploys to `jellyfin-dev` through the self-hosted runner.

Branch names are case-sensitive. Documentation and raw GitHub URLs must use `Main` exactly.

## Workflows

- `build.yml`: validates the repository manifest, compiles pushes and pull requests for `Main` and `dev`, and uploads a development ZIP.
- `deploy-dev.yml`: builds on GitHub-hosted Ubuntu, installs the DLL through the self-hosted Jellyfin runner, and restarts `jellyfin-dev`.
- `release.yml`: accepts a four-part release tag or manual version, requires the source commit to be contained in `Main`, creates the versioned ZIP and MD5 checksum, publishes a GitHub Release, and prepends the release to `repository/manifest.json` on `Main`.

## Self-hosted development runner

The runner must have these labels:

- `self-hosted`
- `linux`
- `x64`
- `jellyfin-qol`

It must be able to use Docker without `sudo` and write to the configured plugin directory. The current development workflow uses:

- container: `jellyfin-dev`
- host plugin directory: `/docker/jellyfin-dev/data/plugins/QoL_Plugin`

The public installation path does not use this runner; users install release ZIPs through the repository manifest.

## Normal development

1. Commit and push changes to `dev`.
2. Wait for **Build plugin** and **Deploy dev to Jellyfin** to succeed.
3. Test the deployed DLL on the development Jellyfin server and Jellyfin Media Player.
4. Merge the verified `dev` commit into `Main`.

## Release

The first release uses the four-part project version `1.0.1.0`. After the verified source is in `Main`, either push tag `v1.0.1.0` or manually run **Release Jellyfin plugin** on `Main` with version `1.0.1.0`.

The release workflow creates:

- `JellyfinQoL-1.0.1.0.zip`
- `JellyfinQoL-1.0.1.0.zip.md5`
- a GitHub Release tagged `v1.0.1.0`
- a validated entry in `repository/manifest.json`

## Jellyfin repository URL

```text
https://raw.githubusercontent.com/FredrikB96/jellyfin-qol-plugin/Main/repository/manifest.json
```

The GitHub repository must be public before Jellyfin can fetch this manifest, its logo, and release ZIP without authentication. Review the repository for private material and decide what to do with the self-hosted deployment runner before changing visibility.
