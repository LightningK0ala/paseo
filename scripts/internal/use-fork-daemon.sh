#!/usr/bin/env bash
# Run the paseo.service user unit from this checkout instead of the npm release.
#
# Installs a systemd drop-in that replaces only ExecStart: same PASEO_HOME
# (~/.paseo), same listen address and password (both come from the existing
# config and the user manager's environment), same PATH for agents. Restarting
# the daemon interrupts running agent turns, so it asks first.
#
#   scripts/internal/use-fork-daemon.sh          # check, install drop-in, restart
#   scripts/internal/use-fork-daemon.sh --check  # only check the build
#
# Roll back with scripts/internal/use-release-daemon.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="${PASEO_FORK_NODE:-$HOME/.local/share/mise/installs/node/$(awk '$1=="nodejs"{print $2}' "$REPO/.tool-versions")/bin/node}"
DROPIN_DIR="$HOME/.config/systemd/user/paseo.service.d"
DROPIN="$DROPIN_DIR/internal-fork.conf"

fail() { echo "error: $*" >&2; exit 1; }

[ -x "$NODE" ] || fail "node not found at $NODE (the version in .tool-versions; set PASEO_FORK_NODE to override)"
for f in packages/cli/dist/index.js packages/server/dist/server/server/bootstrap.js; do
  [ -f "$REPO/$f" ] || fail "missing $f: build first (see scripts/internal/README.md)"
done
version="$("$NODE" -p "require('$REPO/packages/cli/package.json').version")"
commit="$(git -C "$REPO" log -1 --format='%h %s')"
echo "fork build: $REPO"
echo "  version $version, node $("$NODE" --version), HEAD $commit"
[ "${1:-}" = "--check" ] && exit 0

cat <<MSG

Restarting paseo.service stops the daemon for a few seconds and interrupts
any agent turn that is running. Agents that are idle or closed are not
affected; running ones need to be resumed.
MSG
read -r -p "Switch paseo.service to this build and restart it now? [y/N] " answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Nothing changed."; exit 0; }

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN" <<UNIT
# Installed by $REPO/scripts/internal/use-fork-daemon.sh
# Remove with use-release-daemon.sh to go back to the npm release.
[Service]
ExecStart=
ExecStart=$NODE --disable-warning=DEP0040 $REPO/packages/cli/bin/paseo daemon run
UNIT
systemctl --user daemon-reload
systemctl --user restart paseo.service
sleep 3
systemctl --user --no-pager status paseo.service | head -6
echo
echo "Running from the fork. Check it with: journalctl --user -u paseo.service -n 50"
