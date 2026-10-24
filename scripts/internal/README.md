# Internal fork

This checkout is the owner's internally maintained Paseo: the `internal` branch
of `LightningK0ala/paseo` (remote `fork`), built from source and run as the
`paseo.service` user unit in place of the npm release. Upstream (`origin`,
`getpaseo/paseo`) is only a source of fixes to take in; nothing is proposed back.

The branch is a release tag plus the fork's own commits on top, one commit per
change, so each can be rebased or dropped on its own.

## Build

Use the Node version in `.tool-versions` (22.23.4). Put it first on `PATH`
rather than running `mise exec`, which also tries to install the Rust, Java and
Android toolchains the daemon does not need.

```sh
export PATH="$HOME/.local/share/mise/installs/node/$(awk '$1=="nodejs"{print $2}' .tool-versions)/bin:$PATH"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:server          # protocol, client, server, CLI (about a minute)
npm run build:daemon-web-ui   # the web UI the release bundles (about five minutes)
```

The daemon runs straight from `packages/cli/bin/paseo`; there is no install
step. Rebuilding while the fork daemon runs changes files under it, so rebuild,
then restart.

## Switch and roll back

```sh
scripts/internal/use-fork-daemon.sh --check   # show what would run
scripts/internal/use-fork-daemon.sh           # install the drop-in, restart
scripts/internal/use-release-daemon.sh        # remove it, restart on the release
```

The switch is a systemd drop-in, `~/.config/systemd/user/paseo.service.d/internal-fork.conf`,
that replaces only `ExecStart`. Data (`~/.paseo`), config, listen address,
password (from the user manager's environment) and the unit's `PATH` stay as
they are, so there is nothing to migrate and nothing else to undo. While the
version matches the release (`0.11.2` here) the apps see no version drift.

A restart interrupts running agent turns. Switch when no agent is running.

## Take in upstream

```sh
git fetch origin --tags
git rebase --onto vX.Y.Z vOLD internal   # move the fork's commits onto a new release tag
```

Then rebuild, run the server unit tests (`npm run test:unit --workspace=@getpaseo/server`),
and restart. Rebase onto a release tag rather than `origin/main`, so the daemon
and the apps keep matching versions.
