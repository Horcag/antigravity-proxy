#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release-lib.sh
source "$script_dir/release-lib.sh"
release_init
require_live_root

target_id="${1:-}"
if [ -z "$target_id" ]; then
  target_id="$(previous_release_id)" || die "No valid previous release is recorded; pass an explicit release ID"
fi

if [ "$dry_run" = 1 ]; then
  printf 'Would roll back to immutable release %s\n' "$target_id"
  exit 0
fi

acquire_release_lock

current_id=''
previous_id=''
if current_id="$(current_release_id)"; then :; fi
if previous_id="$(previous_release_id)"; then :; fi
[ "$target_id" != "$current_id" ] || die "Refusing a rollback from the current release to itself"
validate_release_runtime "$target_id"
if [ -n "$current_id" ]; then
  validate_release_runtime "$current_id"
fi
switch_to_release "$target_id"
write_unit_for_release "$target_id"
systemd daemon-reload
if ! systemd restart antigravity-proxy.service || ! smoke_check; then
  restore_release_topology "$current_id" "$previous_id"
  if [ -n "$current_id" ]; then
    write_unit_for_release "$current_id"
  fi
  systemd daemon-reload
  if [ -n "$current_id" ]; then
    if ! systemd restart antigravity-proxy.service || ! smoke_check; then
      die "Rollback to release $target_id failed smoke checks and the restored release also failed recovery smoke checks"
    fi
  else
    systemd disable --now antigravity-proxy.service
  fi
  die "Rollback to release $target_id failed smoke checks; prior release topology was restored"
fi
printf 'Rolled back to release %s\n' "$target_id"
