#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_REQUIRE_NPM=1
# shellcheck source=scripts/release-lib.sh
source "$script_dir/release-lib.sh"
release_init
require_live_root

mode="${1:-install}"
case "$mode" in install|update|migrate) ;; *) die "Usage: $0 [install|update|migrate]" ;; esac

if [ "$dry_run" = 1 ]; then
  printf 'Would %s Antigravity Proxy release %s under %s\n' "$mode" "$release_id" "$install_root"
  print_environment_plan
  printf 'Would stage production dependencies as the configured non-root release operator, then probe better-sqlite3 and the built CLI before switching current\n'
  printf 'Would install system unit at %s and helper at %s without printing environment contents\n' "$unit_file" "$import_helper"
  exit 0
fi

if [ "$mode" = migrate ]; then
  validate_migration_set
fi

acquire_release_lock

previous_id=''
previous_previous_id=''
if previous_id="$(current_release_id)"; then
  :
fi
if previous_previous_id="$(previous_release_id)"; then
  :
fi
if [ -n "$previous_id" ]; then
  validate_release_runtime "$previous_id"
fi

legacy_stopped=0
migration_topology=''
migration_release_switched=0
restore_stopped_legacy_service() {
  if [ "$mode" = migrate ] && [ "$legacy_stopped" = 1 ] && [ "$migration_topology" = legacy-only ]; then
    legacy_user_systemd start || die "Failed to restore the legacy user service after migration failure"
    legacy_stopped=0
  fi
}
restore_migration_cutover() {
  local restored_current_id="$1" restored_previous_id="$2"
  local rollback_failed=0
  migration_release_switched=0
  restore_migration_unit_state || rollback_failed=1
  restore_migration_release_topology "$restored_current_id" "$restored_previous_id" || rollback_failed=1
  migration_wants_rollback_is_safe || rollback_failed=1
  if [ "$rollback_failed" -ne 0 ]; then
    systemd stop antigravity-proxy.service || true
    restore_stopped_legacy_service || true
    return 1
  fi
  case "$migration_topology" in
    system-only)
      if [ -n "$restored_current_id" ]; then
        systemd daemon-reload
        if ! systemd restart antigravity-proxy.service || ! smoke_check; then
          die "The restored system release failed recovery smoke checks"
        fi
      else
        systemd disable --now antigravity-proxy.service
      fi
      ;;
    legacy-only|neither)
      systemd disable --now antigravity-proxy.service
      ;;
    *) die "Migration topology was not captured" ;;
  esac
  restore_migration_wants_state || rollback_failed=1
  restore_stopped_legacy_service
  return "$rollback_failed"
}
restore_after_failed_migration() {
  local exit_code=$?
  set +e
  if [ "$exit_code" -ne 0 ]; then
    if [ "$migration_release_switched" = 1 ]; then
      migration_release_switched=0
      if (restore_migration_cutover "$previous_id" "$previous_previous_id"); then
        legacy_stopped=0
      else
        printf '%s\n' 'Migration release topology rollback was incomplete' >&2
      fi
    fi
    rollback_migration_publication || printf '%s\n' 'Migration publication rollback was incomplete' >&2
    restore_migration_unit_state || printf '%s\n' 'Migration system unit rollback was incomplete' >&2
    cleanup_migration_unit_staging || printf '%s\n' 'Migration system unit staging cleanup was incomplete' >&2
    restore_migration_environment_metadata || printf '%s\n' 'Migration environment metadata rollback was incomplete' >&2
  fi
  cleanup_candidate_staging || printf '%s\n' 'Candidate staging cleanup was incomplete' >&2
  cleanup_migration_state_staging || printf '%s\n' 'Migration state staging cleanup was incomplete' >&2
  cleanup_migration_environment_staging || printf '%s\n' 'Migration environment staging cleanup was incomplete' >&2
  if [ "$exit_code" -ne 0 ]; then
    restore_stopped_legacy_service || printf '%s\n' 'Failed to restore the legacy user service after migration failure' >&2
  fi
  exit "$exit_code"
}
trap restore_after_failed_migration EXIT

if [ "$mode" = migrate ]; then
  validate_migration_set
  capture_migration_topology
fi
ensure_layout
if [ "$mode" = migrate ]; then
  snapshot_migration_environment_metadata
fi
ensure_environment_permissions
if [ "$mode" = migrate ] && [ "$migration_environment_had_file" = 1 ]; then
  substitute_migration_test_entry environment "$(
    root_path "$env_file"
  )"
  migration_checkpoint environment-metadata
fi
create_release
release_runtime_probe

if [ "$mode" = migrate ]; then
  if [ "$migration_topology" = legacy-only ]; then
    legacy_user_systemd stop
    legacy_stopped=1
  fi
  stage_legacy_migration_set
  publish_staged_migration_set
else
  if [ "${REQUIRE_EXISTING_ENV:-0}" = 1 ]; then
    require_regular_file "$(root_path "$env_file")" "existing production environment"
  else
    write_environment_if_missing
  fi
fi
validate_environment_contract
if [ "$mode" = migrate ]; then
  prepare_migration_unit_rollback
fi
write_unit "$candidate_staging_fs"
if [ "$mode" = migrate ]; then
  migration_checkpoint unit-write
fi
if [ "${SKIP_IMPORT_HELPER:-0}" != 1 ]; then write_import_helper; fi
commit_candidate_release

if [ "$mode" = migrate ]; then
  migration_release_switched=1
fi
switch_to_release "$release_id"
if [ "$mode" = migrate ]; then
  migration_checkpoint release-switch
fi

if ! activate_release "$( [ -n "$previous_id" ] && printf restart || printf start )"; then
  if [ "$mode" = migrate ]; then
    if ! restore_migration_cutover "$previous_id" "$previous_previous_id"; then
      die "Release $release_id failed smoke checks and migration topology could not be restored"
    fi
  else
    if [ -n "$previous_id" ]; then
      restore_release_topology "$previous_id" "$previous_previous_id"
      write_unit_for_release "$previous_id"
      systemd daemon-reload
      if ! systemd restart antigravity-proxy.service || ! smoke_check; then
        die "Release $release_id failed smoke checks and the restored release also failed recovery smoke checks"
      fi
    else
      systemd disable --now antigravity-proxy.service
      remove_current_link
    fi
  fi
  die "Release $release_id failed smoke checks; previous release was restored"
fi
if [ "$mode" = migrate ]; then
  migration_checkpoint first-smoke
fi

if [ "$mode" = migrate ] && [ "$migration_topology" = legacy-only ]; then
  if ! legacy_user_systemd disable; then
    restore_migration_cutover "$previous_id" "$previous_previous_id"
    die "Could not disable legacy user service; migration was rolled back"
  fi
  legacy_stopped=0
fi

if [ "$mode" = migrate ]; then
  complete_migration_publication
fi

printf '%s release %s is active\n' "$mode" "$release_id"
