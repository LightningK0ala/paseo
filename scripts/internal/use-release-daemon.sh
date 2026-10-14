#!/usr/bin/env bash
# Go back to the npm-installed Paseo release: remove the drop-in that
# use-fork-daemon.sh installed and restart paseo.service. Nothing else changed
# when switching, so nothing else needs undoing (same ~/.paseo, same config).
set -euo pipefail

DROPIN="$HOME/.config/systemd/user/paseo.service.d/internal-fork.conf"
[ -f "$DROPIN" ] || { echo "No fork drop-in installed; paseo.service already runs the release."; exit 0; }

echo "Restarting paseo.service interrupts any agent turn that is running."
read -r -p "Remove the fork drop-in and restart on the release now? [y/N] " answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Nothing changed."; exit 0; }

rm "$DROPIN"
rmdir --ignore-fail-on-non-empty "$(dirname "$DROPIN")"
systemctl --user daemon-reload
systemctl --user restart paseo.service
sleep 3
systemctl --user --no-pager status paseo.service | head -6
