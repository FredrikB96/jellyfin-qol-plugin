# GitHub development + release setup

Recommended repository: `FredrikB96/jellyfin-qol-plugin`.

## Branches

- `main`: releasable source.
- `dev`: active development; every push auto-builds and, once the self-hosted runner is configured, auto-deploys to the Jellyfin Docker container.

## Workflows

- `build.yml`: compiles on pushes/PRs to `main` or `dev` and uploads a ZIP artifact.
- `deploy-dev.yml`: builds on GitHub-hosted Ubuntu, downloads the DLL on your self-hosted Jellyfin runner, copies it into the container, and restarts Jellyfin.
- `release.yml`: release tag such as `v1.0.2.0` builds a versioned DLL/ZIP, creates a GitHub Release, calculates the MD5 expected by Jellyfin's plugin repository manifest, and updates `repository/manifest.json` on `main`.

## Self-hosted runner

Keep the repository PRIVATE while automatic deployment is enabled.

On GitHub open:

`Repository -> Settings -> Actions -> Runners -> New self-hosted runner`

Choose Linux x64 and run the commands GitHub provides on the Ubuntu host that runs the `jellyfin` Docker container.

When configuring the runner, add the custom label:

`jellyfin-qol`

The deploy workflow expects labels:

`self-hosted`, `linux`, `x64`, `jellyfin-qol`

The runner account must be able to use Docker without sudo. Usually:

```bash
sudo usermod -aG docker <runner-user>
```

Log out/in or restart the runner service after changing group membership.

The workflow currently assumes:

- container name: `jellyfin`
- plugin path inside container: `/config/plugins/Jellyfin QoL Plugin`

Change the `env:` values in `.github/workflows/deploy-dev.yml` if needed.

## Normal development

Push changes to `dev`. GitHub will build them and then the self-hosted runner will copy the new DLL into Jellyfin and restart the container.

## Release

Merge the desired `dev` state to `main`, then create a four-part tag:

```bash
git checkout main
git pull
git tag v1.0.2.0
git push origin v1.0.2.0
```

The release workflow creates the release ZIP and updates `repository/manifest.json`.

## Jellyfin repository URL

Once the GitHub repository is PUBLIC, add this URL in Jellyfin:

`https://raw.githubusercontent.com/FredrikB96/jellyfin-qol-plugin/main/repository/manifest.json`

A private GitHub repository cannot serve anonymous release assets/manifest to Jellyfin. During development, keep it private and use the self-hosted runner. Before making the repository public, disable/remove the self-hosted deployment runner or move deployment automation to a separate private repository.


## Current HTPC deployment values

No `.env` file is required. The development workflow currently uses:

- runner labels: `self-hosted`, `Linux`, `X64`, `jellyfin-qol`
- Jellyfin container: `jellyfin`
- host plugin directory: `/docker/jellyfin/data/plugins/QoL_Plugin`
- stable branch: `Main`
- development branch: `dev`

The self-hosted runner service account must be able to run `docker` without sudo and write to the plugin directory.
