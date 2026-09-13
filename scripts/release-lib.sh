#!/usr/bin/env bash
# Shared primitives for the systemd release scripts. This file is sourced, not executed.
# shellcheck source=scripts/release-runtime-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-runtime-lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/release-prebuilt-lib.sh"
release_init() {
  project_dir="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  root_prefix="${ROOT_PREFIX:-}"
  install_root="${INSTALL_ROOT:-${INSTALL_DIR:-/opt/antigravity-proxy}}"
  data_dir="${DATA_DIR:-/var/lib/antigravity-proxy}"
  env_file="${ENV_FILE:-/etc/antigravity-proxy/antigravity-proxy.env}"
  env_dir="$(dirname "$env_file")"
  unit_file="/etc/systemd/system/antigravity-proxy.service"
  import_helper="/usr/local/sbin/antigravity-proxy-import"
  user_name="${SERVICE_USER:-antigravity-proxy}"
  service_group="${SERVICE_GROUP:-$user_name}"
  release_operator="${RELEASE_OPERATOR:-${SUDO_USER:-}}"
  release_id="${RELEASE_ID:-$(date -u +%Y%m%d%H%M%S)-$(git -C "$project_dir" rev-parse --short HEAD)}"
  bundle_node="${BUNDLE_NODE:-1}"
  test_mode="${RELEASE_TEST_MODE:-0}"
  dry_run="${DRY_RUN:-0}"; prebuilt_release_archive="${PREBUILT_RELEASE_ARCHIVE:-}"
  release_lock_file="${RELEASE_LOCK_FILE:-/run/lock/antigravity-proxy-release.lock}"
  candidate_staging_fs=''
  candidate_staging_identity=''
  migration_state_staging_fs=''
  migration_state_staging_identity=''
  migration_environment_staging_fs=''
  migration_environment_staging_identity=''
  migration_published_paths=()
  migration_published_identities=()
  migration_published_kinds=()
  migration_publication_open=0
  migration_link_paths=()
  migration_link_identities=()
  migration_link_previous_ids=()
  migration_environment_had_file=0
  migration_environment_identity=''
  migration_environment_metadata=''
  migration_unit_backup_fs=''
  migration_unit_backup_identity=''
  migration_unit_had_file=0
  migration_unit_published_identity=''
  migration_unit_rename_completed=0
  migration_unit_staging_fs=''
  migration_unit_staging_identity=''
  migration_wants_fs=''
  migration_wants_backup_fs=''
  migration_wants_backup_identity=''
  migration_wants_had_entry=0
  migration_wants_published_identity=''
  migration_smoke_check_count=0
  migration_topology=''
  case "$root_prefix" in
    '') ;;
    /*) ;;
    *) die "ROOT_PREFIX must be an absolute path" ;;
  esac
  if [ "$test_mode" = 1 ]; then
    case "$root_prefix" in
      ''|/) die "RELEASE_TEST_MODE requires a non-root absolute ROOT_PREFIX" ;;
    esac
    root_prefix="$(readlink -m -- "$root_prefix")"
    [ "$root_prefix" != / ] || die "RELEASE_TEST_MODE requires a non-root absolute ROOT_PREFIX"
  fi
  require_absolute_path "$install_root" INSTALL_ROOT
  require_absolute_path "$data_dir" DATA_DIR
  require_absolute_path "$env_file" ENV_FILE
  require_absolute_path "$release_lock_file" RELEASE_LOCK_FILE
  validate_release_id "$release_id"
  case "$bundle_node" in 0|1) ;; *) die "BUNDLE_NODE must be 0 or 1" ;; esac
  resolve_release_runtime

  releases_dir="$install_root/releases"
  current_link="$install_root/current"
  previous_link="$install_root/previous"
  release_dir="$releases_dir/$release_id"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_absolute_path() {
  case "$1" in
    /*) ;;
    *) die "$2 must be an absolute path" ;;
  esac
}

validate_release_id() {
  case "$1" in
    *[!A-Za-z0-9._-]*|'') die "RELEASE_ID may contain only letters, digits, dot, underscore, and hyphen" ;;
  esac
}

root_path() {
  printf '%s%s\n' "$root_prefix" "$1"
}

require_safe_directory() {
  local path="$1" label="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if ! { [ -d "$path" ] && [ ! -L "$path" ]; }; then
      die "$label must be a real directory"
    fi
  else
    install -d -m "$3" "$path"
  fi
}

require_regular_file() {
  local path="$1" label="$2"
  if ! { [ -f "$path" ] && [ ! -L "$path" ]; }; then
    die "$label must be a regular non-symlink file"
  fi
}

validate_optional_regular_file() {
  local path="$1" label="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    require_regular_file "$path" "$label"
  fi
}

validate_existing_parent_directories() {
  local path="$1" label="$2"
  path="$(dirname "$path")"
  while [ "$path" != / ]; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      if ! { [ -d "$path" ] && [ ! -L "$path" ]; }; then
        die "$label parent must be a real directory: $path"
      fi
    fi
    path="$(dirname "$path")"
  done
}

file_identity() {
  stat -c '%d:%i:%F:%s' -- "$1"
}

matches_identity() {
  local path="$1" expected_identity="$2"
  if ! { [ -e "$path" ] || [ -L "$path" ]; }; then
    return 1
  fi
  [ "$(file_identity "$path")" = "$expected_identity" ]
}

publication_identity() {
  stat -c '%d:%i:%F:%s@%z' -- "$1"
}

matches_publication_identity() {
  local path="$1" expected_identity="$2"
  if ! { [ -e "$path" ] || [ -L "$path" ]; }; then
    return 1
  fi
  [ "$(publication_identity "$path")" = "$expected_identity" ]
}

# publication_identity includes ctime to detect in-place replacement. ctime changes on
# rename, so a quarantined object is compared to the stable inode portion recorded
# before publication rather than re-observing the newly published pathname.
matches_detached_publication_identity() {
  local path="$1" expected_identity="$2"
  if ! { [ -e "$path" ] || [ -L "$path" ]; }; then
    return 1
  fi
  [ "$(file_identity "$path")" = "${expected_identity%%@*}" ]
}

fsync_directory() {
  sync -f -- "$1"
}

matches_owned_kind() {
  local path="$1" kind="$2"
  case "$kind" in
    directory) [ -d "$path" ] && [ ! -L "$path" ] ;;
    file) [ -f "$path" ] && [ ! -L "$path" ] ;;
    link) [ -L "$path" ] ;;
    *) die "Unknown owned path kind: $kind" ;;
  esac
}

# The quarantine directory is private and on the source filesystem. Once rename has
# detached the object, cleanup never traverses the attacker-visible original pathname.
quarantine_owned_path() {
  local path="$1" expected_identity="$2" kind="$3" label="$4" test_checkpoint="${5:-}"
  local parent base
  owned_quarantine_path=''
  owned_quarantine_dir=''
  if ! { [ -e "$path" ] || [ -L "$path" ]; }; then
    return 2
  fi
  parent="$(dirname "$path")"
  base="$(basename "$path")"
  owned_quarantine_dir="$(umask 077 && mktemp -d "$parent/.${base}.quarantine.XXXXXX")" || {
    printf '%s\n' "Refusing to create a private cleanup quarantine for $label: $path" >&2
    return 1
  }
  owned_quarantine_path="$owned_quarantine_dir/object"
  if ! mv -Tn -- "$path" "$owned_quarantine_path"; then
    rmdir -- "$owned_quarantine_dir" 2>/dev/null || true
    printf '%s\n' "Refusing to atomically detach $label for cleanup: $path" >&2
    return 1
  fi
  if [ -n "$test_checkpoint" ]; then
    substitute_cleanup_test_entry "$test_checkpoint" "$path"
  fi
  if { [ -e "$path" ] || [ -L "$path" ]; }; then
    printf '%s\n' "Retained path after atomic cleanup detach: $path (quarantine: $owned_quarantine_dir)" >&2
    return 1
  fi
  if ! { matches_owned_kind "$owned_quarantine_path" "$kind" && matches_detached_publication_identity "$owned_quarantine_path" "$expected_identity"; }; then
    if mv -Tn -- "$owned_quarantine_path" "$path" && ! { [ -e "$owned_quarantine_path" ] || [ -L "$owned_quarantine_path" ]; }; then
      rmdir -- "$owned_quarantine_dir" 2>/dev/null || true
      printf '%s\n' "Refusing to clean a substituted $label; restored it without overwriting: $path" >&2
    else
      printf '%s\n' "Refusing to clean a substituted $label; retained quarantine: $owned_quarantine_dir" >&2
    fi
    return 1
  fi
  return 0
}

discard_owned_quarantine() {
  local expected_identity="$1" kind="$2" label="$3"
  if ! { [ -n "$owned_quarantine_path" ] && matches_owned_kind "$owned_quarantine_path" "$kind" && matches_detached_publication_identity "$owned_quarantine_path" "$expected_identity"; }; then
    printf '%s\n' "Refusing to delete a substituted detached $label: ${owned_quarantine_path:-missing}" >&2
    return 1
  fi
  case "$kind" in
    directory) rm -rf -- "$owned_quarantine_path" ;;
    file|link) rm -- "$owned_quarantine_path" ;;
    *) die "Unknown owned path kind: $kind" ;;
  esac
  if { [ -e "$owned_quarantine_path" ] || [ -L "$owned_quarantine_path" ]; } || ! rmdir -- "$owned_quarantine_dir"; then
    printf '%s\n' "Refusing to leave an unverified cleanup quarantine for $label: $owned_quarantine_dir" >&2
    return 1
  fi
  owned_quarantine_path=''
  owned_quarantine_dir=''
  return 0
}

safe_cleanup_owned_path() {
  local path="$1" expected_identity="$2" kind="$3" label="$4" test_checkpoint="$5" status
  if ! { [ -e "$path" ] || [ -L "$path" ]; }; then
    return 0
  fi
  if quarantine_owned_path "$path" "$expected_identity" "$kind" "$label" "$test_checkpoint"; then
    discard_owned_quarantine "$expected_identity" "$kind" "$label"
    return $?
  else
    status=$?
  fi
  [ "$status" -eq 2 ] && return 0
  return "$status"
}

migration_state_entries() {
  printf '%s\n' accounts.db accounts.db-wal accounts.db-shm .master-key config.json
}

validate_state_topology() {
  local state_fs="$1" label="$2" file
  if [ -e "$state_fs" ] || [ -L "$state_fs" ]; then
    if ! { [ -d "$state_fs" ] && [ ! -L "$state_fs" ]; }; then
      die "$label directory must be a real directory"
    fi
  fi
  while IFS= read -r file; do
    validate_optional_regular_file "$state_fs/$file" "$label $file"
  done < <(migration_state_entries)
}

copy_regular_file() {
  local source="$1" target="$2" mode="$3" label="$4" temporary
  require_regular_file "$source" "$label source"
  if [ -e "$target" ] || [ -L "$target" ]; then
    die "$label target already exists"
  fi
  temporary="${target}.tmp.$$"
  if ! { [ ! -e "$temporary" ] && [ ! -L "$temporary" ]; }; then
    die "Refusing to overwrite pending $label copy"
  fi
  cp --no-dereference -- "$source" "$temporary"
  require_regular_file "$temporary" "$label staged copy"
  chmod "$mode" "$temporary"
  if ! is_simulated; then
    chown --no-dereference "$user_name:$service_group" "$temporary"
  fi
  mv -Tf -- "$temporary" "$target"
  require_regular_file "$target" "$label target"
}

acquire_release_lock() {
  local lock_fs lock_dir
  lock_fs="$(root_path "$release_lock_file")"
  lock_dir="$(dirname "$lock_fs")"
  require_safe_directory "$lock_dir" "release lock directory" 0755
  if [ -e "$lock_fs" ] || [ -L "$lock_fs" ]; then
    require_regular_file "$lock_fs" "release lock"
  else
    (umask 0077 && set -C && : >"$lock_fs") 2>/dev/null || require_regular_file "$lock_fs" "release lock"
  fi
  require_regular_file "$lock_fs" "release lock"
  if ! is_simulated; then
    chown --no-dereference root:root "$lock_fs"
    chmod 0600 "$lock_fs"
  fi
  exec {release_lock_fd}<>"$lock_fs"
  flock -n "$release_lock_fd" || die "Another Antigravity Proxy release transaction is in progress"
}

cleanup_candidate_staging() {
  if [ -z "$candidate_staging_fs" ]; then
    return 0
  fi
  case "$candidate_staging_fs" in
    "$(root_path "$releases_dir")"/.staging-*) ;;
    *) die "Refusing to clean an invalid candidate staging path" ;;
  esac
  if [ -e "$candidate_staging_fs" ] || [ -L "$candidate_staging_fs" ]; then
    safe_cleanup_owned_path "$candidate_staging_fs" "$candidate_staging_identity" directory "candidate staging directory" candidate-staging || return
  fi
  candidate_staging_fs=''
  candidate_staging_identity=''
  return 0
}

cleanup_migration_state_staging() {
  local data_fs
  [ -n "$migration_state_staging_fs" ] || return 0
  data_fs="$(root_path "$data_dir")"
  case "$migration_state_staging_fs" in
    "$data_fs"/.migration-staging-*) ;;
    *) die "Refusing to clean an invalid migration state staging path" ;;
  esac
  if [ -e "$migration_state_staging_fs" ] || [ -L "$migration_state_staging_fs" ]; then
    safe_cleanup_owned_path "$migration_state_staging_fs" "$migration_state_staging_identity" directory "migration state staging directory" migration-state-staging || return
  fi
  migration_state_staging_fs=''
  migration_state_staging_identity=''
  return 0
}

cleanup_migration_environment_staging() {
  local env_fs
  [ -n "$migration_environment_staging_fs" ] || return 0
  env_fs="$(root_path "$env_file")"
  case "$migration_environment_staging_fs" in
    "$env_fs".migration-staging-*) ;;
    *) die "Refusing to clean an invalid migration environment staging path" ;;
  esac
  if [ -e "$migration_environment_staging_fs" ] || [ -L "$migration_environment_staging_fs" ]; then
    safe_cleanup_owned_path "$migration_environment_staging_fs" "$migration_environment_staging_identity" file "migration environment staging file" migration-environment-staging || return
  fi
  migration_environment_staging_fs=''
  migration_environment_staging_identity=''
  return 0
}

record_migration_publication() {
  local path="$1" kind="${2:-file}"
  case "$kind" in
    file) require_regular_file "$path" "migration publication" ;;
    directory)
      if ! { [ -d "$path" ] && [ ! -L "$path" ]; }; then
        die "migration publication must be a real directory: $path"
      fi
      ;;
    link)
      if [ ! -L "$path" ]; then
        die "migration publication must be a symbolic link: $path"
      fi
      ;;
    *) die "Unknown migration publication kind: $kind" ;;
  esac
  migration_published_paths+=("$path")
  migration_published_identities+=("$(publication_identity "$path")")
  migration_published_kinds+=("$kind")
  migration_publication_open=1
  fsync_directory "$(dirname "$path")"
}

rollback_migration_publication() {
  local index path expected_identity kind rollback_failed=0
  [ "$migration_publication_open" = 1 ] || return 0
  for ((index = ${#migration_published_paths[@]} - 1; index >= 0; index--)); do
    path="${migration_published_paths[$index]}"
    expected_identity="${migration_published_identities[$index]}"
    kind="${migration_published_kinds[$index]}"
    case "$kind" in
      file|link)
        local q_status=0
        quarantine_owned_path "$path" "$expected_identity" "$kind" "migration rollback $kind" "migration-publication-$kind" || q_status=$?
        if [ "$q_status" -ne 0 ]; then
          if [ "$q_status" -eq 2 ]; then
            continue
          fi
          printf '%s\n' "Refusing to remove substituted migration rollback entry: $path" >&2
          rollback_failed=1
          continue
        fi
        if ! discard_owned_quarantine "$expected_identity" "$kind" "migration rollback $kind"; then
          rollback_failed=1
          continue
        fi
        ;;
      directory)
        if [ "$path" != "$(root_path "$release_dir")" ]; then
          printf '%s\n' "Refusing to remove an unsafe migration release directory: $path" >&2
          rollback_failed=1
          continue
        fi
        local q_dir_status=0
        quarantine_owned_path "$path" "$expected_identity" directory "migration release directory" migration-release-directory || q_dir_status=$?
        if [ "$q_dir_status" -ne 0 ]; then
          if [ "$q_dir_status" -eq 2 ]; then
            continue
          fi
          printf '%s\n' "Refusing to remove substituted migration rollback entry: $path" >&2
          rollback_failed=1
          continue
        fi
        if ! discard_owned_quarantine "$expected_identity" directory "migration release directory"; then
          rollback_failed=1
          continue
        fi
        ;;
      *) die "Unknown migration publication kind: $kind" ;;
    esac
    fsync_directory "$(dirname "$path")"
  done
  migration_published_paths=()
  migration_published_identities=()
  migration_published_kinds=()
  migration_publication_open=0
  return "$rollback_failed"
}

complete_migration_publication() {
  migration_published_paths=()
  migration_published_identities=()
  migration_published_kinds=()
  migration_publication_open=0
  complete_migration_unit_rollback
}

is_simulated() {
  [ -n "$root_prefix" ] || [ "$test_mode" = 1 ] || [ "$dry_run" = 1 ]
}

require_live_root() {
  if ! is_simulated && [ "$(id -u)" -ne 0 ]; then
    die "Run as root, or use ROOT_PREFIX/RELEASE_TEST_MODE for a non-live test"
  fi
}

chown_service() {
  if ! is_simulated; then
    chown "$user_name:$service_group" "$@"
  fi
}

chown_root() {
  if ! is_simulated; then
    chown -R root:root "$@"
  fi
}

ensure_service_user() {
  if is_simulated; then
    return
  fi
  if ! id "$user_name" >/dev/null 2>&1; then
    useradd --system --home-dir "$data_dir" --shell /usr/sbin/nologin "$user_name"
  fi
}

print_environment_plan() {
  printf 'Would ensure environment directory %s owner root:%s mode 0750\n' "$env_dir" "$service_group"
  printf 'Would ensure environment file %s owner root:%s mode 0640 without printing its contents\n' "$env_file" "$service_group"
}

ensure_environment_permissions() {
  local env_dir_fs env_fs
  env_dir_fs="$(root_path "$env_dir")"
  env_fs="$(root_path "$env_file")"
  require_safe_directory "$env_dir_fs" "environment directory" 0750
  if ! is_simulated; then
    chown --no-dereference root:"$service_group" "$env_dir_fs"
  fi
  chmod 0750 "$env_dir_fs"
  if [ -e "$env_fs" ] || [ -L "$env_fs" ]; then
    require_regular_file "$env_fs" "environment file"
    if ! is_simulated; then
      chown --no-dereference root:"$service_group" "$env_fs"
    fi
    chmod 0640 "$env_fs"
  fi
}

snapshot_migration_environment_metadata() {
  local env_fs
  env_fs="$(root_path "$env_file")"
  if [ -e "$env_fs" ] || [ -L "$env_fs" ]; then
    require_regular_file "$env_fs" "target environment file"
    migration_environment_had_file=1
    migration_environment_identity="$(file_identity "$env_fs")"
    migration_environment_metadata="$(stat -c '%u:%g:%a' -- "$env_fs")"
  fi
}

restore_migration_environment_metadata() {
  local env_fs uid gid file_mode
  [ "$migration_environment_had_file" = 1 ] || return 0
  env_fs="$(root_path "$env_file")"
  if ! { [ -f "$env_fs" ] && [ ! -L "$env_fs" ] && matches_identity "$env_fs" "$migration_environment_identity"; }; then
    printf '%s\n' "Refusing to restore metadata on substituted migration environment file: $env_fs" >&2
    return 1
  fi
  IFS=: read -r uid gid file_mode <<<"$migration_environment_metadata"
  if ! is_simulated; then
    chown --no-dereference "$uid:$gid" "$env_fs"
  fi
  chmod "$file_mode" "$env_fs"
  fsync_directory "$(dirname "$env_fs")"
  migration_environment_had_file=0
  migration_environment_identity=''
  migration_environment_metadata=''
}

generate_secret() {
  "$node_binary" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
}

write_environment_if_missing() {
  local env_fs
  env_fs="$(root_path "$env_file")"
  ensure_environment_permissions
  if [ -e "$env_fs" ] || [ -L "$env_fs" ]; then
    require_regular_file "$env_fs" "environment file"
    return
  fi
  if [ "$dry_run" = 1 ]; then
    printf 'Would create environment file at %s without printing its contents\n' "$env_file"
    return
  fi

  local proxy_key admin_key
  proxy_key="$(generate_secret)"
  admin_key="$(generate_secret)"
  umask 0077
  {
    printf '%s\n' 'AG_PROXY_HOST=127.0.0.1'
    printf '%s\n' 'AG_PROXY_PORT=8045'
    printf 'AG_PROXY_DATA_DIR=%s\n' "$data_dir"
    printf 'AG_PROXY_API_KEY=%s\n' "$proxy_key"
    printf 'AG_PROXY_ADMIN_API_KEY=%s\n' "$admin_key"
    printf '%s\n' '# Fill these before importing accounts so refresh tokens can be renewed.'
    printf '%s\n' 'AG_PROXY_OAUTH_CLIENT_ID='
    printf '%s\n' 'AG_PROXY_OAUTH_CLIENT_SECRET='
  } >"$env_fs"
  if ! is_simulated; then
    chown root:"$service_group" "$env_fs"
  fi
  chmod 0640 "$env_fs"
}

ensure_layout() {
  local install_fs releases_fs data_fs
  install_fs="$(root_path "$install_root")"
  releases_fs="$(root_path "$releases_dir")"
  data_fs="$(root_path "$data_dir")"
  ensure_service_user
  require_safe_directory "$install_fs" "install root" 0755
  require_safe_directory "$releases_fs" "releases directory" 0755
  validate_state_topology "$data_fs" "persistent state"
  require_safe_directory "$data_fs" "persistent state directory" 0700
  chown_service "$data_fs"
}

create_release() {
  local release_fs staging_fs
  release_fs="$(root_path "$release_dir")"
  staging_fs="$(root_path "$releases_dir")/.staging-${release_id}.$$"
  [ ! -e "$release_fs" ] || die "Release already exists: $release_dir"
  [ ! -e "$staging_fs" ] || die "Staging path already exists: $staging_fs"
  [ -n "$prebuilt_release_archive" ] || [ -d "$project_dir/dist" ] || die "Missing build output: $project_dir/dist (run npm run build first)"

  if [ "$dry_run" = 1 ]; then
    printf 'Would create immutable release %s\n' "$release_dir"
    return
  fi

  mkdir -m 0755 "$staging_fs"
  candidate_staging_fs="$staging_fs"
  candidate_staging_identity="$(publication_identity "$staging_fs")"
  if [ -n "$prebuilt_release_archive" ]; then stage_prebuilt_release; return; fi
  cp -a "$project_dir/dist" "$staging_fs/dist"
  install -m 0644 "$project_dir/package.json" "$staging_fs/package.json"
  install -m 0644 "$project_dir/package-lock.json" "$staging_fs/package-lock.json"
  if [ "$test_mode" = 1 ]; then
    [ -d "$project_dir/node_modules" ] || die "Test release requires installed project dependencies"
    ln -s "$project_dir/node_modules" "$staging_fs/node_modules"
    if [ "${RELEASE_TEST_EXERCISE_OPERATOR_NPM:-0}" = 1 ]; then
      stage_release_dependencies_as_operator
    fi
  else
    stage_release_dependencies_as_operator
  fi
  if [ "$bundle_node" = 1 ]; then
    install -D -m 0755 "$node_binary" "$staging_fs/bin/node"
  fi
  candidate_staging_identity="$(publication_identity "$staging_fs")"
}

commit_candidate_release() {
  local release_fs
  release_fs="$(root_path "$release_dir")"
  [ -n "$candidate_staging_fs" ] || die "No candidate release is staged"
  if ! { [ -d "$candidate_staging_fs" ] && [ ! -L "$candidate_staging_fs" ] && matches_publication_identity "$candidate_staging_fs" "$candidate_staging_identity"; }; then
    die "Candidate release staging is unsafe"
  fi
  if ! { [ ! -e "$release_fs" ] && [ ! -L "$release_fs" ]; }; then
    die "Release already exists: $release_dir"
  fi
  mv -T -- "$candidate_staging_fs" "$release_fs"
  candidate_staging_fs=''
  candidate_staging_identity=''
  chown_root "$release_fs"
  if [ "${mode:-}" = migrate ]; then
    record_migration_publication "$release_fs" directory
    substitute_migration_test_entry release "$release_fs"
    migration_checkpoint release
  fi
}

release_id_from_link() {
  local link_fs="$1" releases_fs resolved target_id
  [ -L "$link_fs" ] || return 1
  releases_fs="$(readlink -f "$(root_path "$releases_dir")")"
  resolved="$(readlink -f "$link_fs")" || return 1
  case "$resolved" in
    "$releases_fs"/*) target_id="${resolved#"$releases_fs"/}" ;;
    *) return 1 ;;
  esac
  case "$target_id" in */*|'') return 1 ;; esac
  validate_release_id "$target_id"
  [ -d "$resolved" ] || return 1
  printf '%s\n' "$target_id"
}

current_release_id() {
  release_id_from_link "$(root_path "$current_link")"
}

previous_release_id() {
  release_id_from_link "$(root_path "$previous_link")"
}

remove_recorded_release_link() {
  local link_fs="$1" label="$2" test_checkpoint="$3" expected_identity
  if ! { [ -e "$link_fs" ] || [ -L "$link_fs" ]; }; then
    return 0
  fi
  if [ ! -L "$link_fs" ]; then
    die "Refusing to remove a non-link $label: $link_fs"
  fi
  expected_identity="$(publication_identity "$link_fs")"
  safe_cleanup_owned_path "$link_fs" "$expected_identity" link "$label" "$test_checkpoint"
}

set_release_link() {
  local link_fs="$1" target_id="${2:-}" label="${3:-release link}" test_checkpoint="${4:-release-link-removal}" next_fs
  next_fs="${link_fs}.next"
  if [ -e "$next_fs" ] || [ -L "$next_fs" ]; then
    die "Refusing to overwrite pending switch: $next_fs"
  fi
  if [ -z "$target_id" ]; then
    remove_recorded_release_link "$link_fs" "$label" "$test_checkpoint"
    return
  fi
  validate_release_id "$target_id"
  [ -d "$(root_path "$releases_dir/$target_id")" ] || die "Release does not exist: $target_id"
  ln -s "releases/$target_id" "$next_fs"
  mv -Tf "$next_fs" "$link_fs"
}

record_migration_link_publication() {
  local link_fs="$1" prior_id="$2"
  if [ "${mode:-}" != migrate ]; then
    return
  fi
  if [ ! -L "$link_fs" ]; then
    die "Migration release link was not published: $link_fs"
  fi
  migration_link_paths+=("$link_fs")
  migration_link_identities+=("$(publication_identity "$link_fs")")
  migration_link_previous_ids+=("$prior_id")
}

restore_migration_release_topology() {
  local index path expected_identity prior_id restored_link rollback_failed=0
  for ((index = ${#migration_link_paths[@]} - 1; index >= 0; index--)); do
    path="${migration_link_paths[$index]}"
    expected_identity="${migration_link_identities[$index]}"
    prior_id="${migration_link_previous_ids[$index]}"
    local q_link_status=0
    quarantine_owned_path "$path" "$expected_identity" link "migration release link" migration-release-link || q_link_status=$?
    if [ "$q_link_status" -ne 0 ]; then
      if [ "$q_link_status" -eq 2 ]; then
        if [ -z "$prior_id" ]; then
          continue
        fi
        local restore_staging_dir
        restore_staging_dir="$(umask 077 && mktemp -d "$(dirname "$path")/.restore.XXXXXX")" || {
          printf '%s\n' "Refusing to create staging dir for restoring absent migration link: $path" >&2
          rollback_failed=1
          continue
        }
        restored_link="$restore_staging_dir/restore"
        if ! ln -s "releases/$prior_id" "$restored_link" || ! mv -Tn -- "$restored_link" "$path" || { [ -e "$restored_link" ] || [ -L "$restored_link" ]; }; then
          rm -rf -- "$restore_staging_dir" 2>/dev/null || true
          printf '%s\n' "Refusing to restore migration release link without overwriting a concurrent replacement: $path" >&2
          rollback_failed=1
          continue
        fi
        rmdir -- "$restore_staging_dir" 2>/dev/null || true
        fsync_directory "$(dirname "$path")"
        continue
      fi
      printf '%s\n' "Refusing to restore substituted migration release link: $path" >&2
      rollback_failed=1
      continue
    fi
    if [ -n "$prior_id" ]; then
      restored_link="$owned_quarantine_dir/restore"
      if ! ln -s "releases/$prior_id" "$restored_link" || ! mv -Tn -- "$restored_link" "$path" || { [ -e "$restored_link" ] || [ -L "$restored_link" ]; }; then
        printf '%s\n' "Refusing to restore migration release link without overwriting a concurrent replacement: $path" >&2
        rollback_failed=1
        continue
      fi
    fi
    if ! discard_owned_quarantine "$expected_identity" link "migration release link"; then
      rollback_failed=1
      continue
    fi
    fsync_directory "$(dirname "$path")"
  done
  if [ "$rollback_failed" -eq 0 ]; then
    migration_link_paths=()
    migration_link_identities=()
    migration_link_previous_ids=()
  fi
  return "$rollback_failed"
}

switch_to_release() {
  local target_id="$1" current_fs previous_fs old_id old_previous_id
  validate_release_id "$target_id"
  [ -d "$(root_path "$releases_dir/$target_id")" ] || die "Release does not exist: $target_id"
  current_fs="$(root_path "$current_link")"
  previous_fs="$(root_path "$previous_link")"
  if old_previous_id="$(previous_release_id)"; then :; fi
  if old_id="$(current_release_id)"; then
    set_release_link "$previous_fs" "$old_id"
    if [ "${mode:-}" = migrate ]; then
      record_migration_link_publication "$previous_fs" "$old_previous_id"
      substitute_migration_test_entry previous "$previous_fs"
      migration_checkpoint previous
    fi
  fi
  set_release_link "$current_fs" "$target_id"
  if [ "${mode:-}" = migrate ]; then
    record_migration_link_publication "$current_fs" "$old_id"
    substitute_migration_test_entry current "$current_fs"
    migration_checkpoint current
  fi
}

restore_release_topology() {
  local current_id="${1:-}" previous_id="${2:-}"
  set_release_link "$(root_path "$current_link")" "$current_id" "empty-topology current release link" empty-topology-release-link || return
  set_release_link "$(root_path "$previous_link")" "$previous_id" "empty-topology previous release link" empty-topology-release-link
}

remove_current_link() {
  local current_fs
  current_fs="$(root_path "$current_link")"
  remove_recorded_release_link "$current_fs" "failed first activation current release link" failed-first-activation-current-link
}

write_import_helper() {
  local helper_fs
  helper_fs="$(root_path "$import_helper")"
  install -d -m 0755 "$(dirname "$helper_fs")"
  install -m 0755 "$project_dir/scripts/import-accounts-stdin.sh" "$helper_fs"
}

prepare_migration_unit_rollback() {
  local unit_fs wants_dir
  unit_fs="$(root_path "$unit_file")"
  if [ -e "$unit_fs" ] || [ -L "$unit_fs" ]; then
    require_regular_file "$unit_fs" "system unit"
    migration_unit_had_file=1
    migration_unit_backup_fs="${unit_fs}.migration-backup-${release_id}.$$"
    if [ -e "$migration_unit_backup_fs" ] || [ -L "$migration_unit_backup_fs" ]; then
      die "Migration system unit backup path already exists"
    fi
    cp -p --no-dereference -- "$unit_fs" "$migration_unit_backup_fs"
    require_regular_file "$migration_unit_backup_fs" "migration system unit backup"
    migration_unit_backup_identity="$(publication_identity "$migration_unit_backup_fs")"
  fi
  migration_wants_fs="$(root_path "/etc/systemd/system/multi-user.target.wants/antigravity-proxy.service")"
  wants_dir="$(dirname "$migration_wants_fs")"
  if [ -e "$migration_wants_fs" ] || [ -L "$migration_wants_fs" ]; then
    migration_wants_had_entry=1
    migration_wants_backup_fs="$wants_dir/.antigravity-proxy.service.migration-backup-${release_id}.$$"
    if [ -e "$migration_wants_backup_fs" ] || [ -L "$migration_wants_backup_fs" ]; then
      die "Migration system wants backup path already exists"
    fi
    cp -a --no-dereference -- "$migration_wants_fs" "$migration_wants_backup_fs"
    migration_wants_backup_identity="$(publication_identity "$migration_wants_backup_fs")"
  fi
}

restore_migration_unit_state() {
  local unit_fs backup_quarantine_path='' backup_quarantine_dir=''
  unit_fs="$(root_path "$unit_file")"
  [ -n "$migration_unit_published_identity" ] || return 0
  if [ "$migration_unit_rename_completed" != 1 ]; then
    complete_migration_unit_rollback
    return
  fi
  if [ "$migration_unit_had_file" = 1 ]; then
    if ! quarantine_owned_path "$migration_unit_backup_fs" "$migration_unit_backup_identity" file "migration system unit backup for restore" migration-unit-backup-restore; then
      printf '%s\n' "Refusing to restore from substituted migration system unit backup: $migration_unit_backup_fs" >&2
      return 1
    fi
    backup_quarantine_path="$owned_quarantine_path"
    backup_quarantine_dir="$owned_quarantine_dir"
  fi
  local q_unit_status=0
  quarantine_owned_path "$unit_fs" "$migration_unit_published_identity" file "migration system unit" || q_unit_status=$?
  if [ "$q_unit_status" -ne 0 ]; then
    if [ "$q_unit_status" -eq 2 ]; then
      if [ "$migration_unit_had_file" = 0 ]; then
        migration_unit_backup_fs=''
        migration_unit_backup_identity=''
        migration_unit_published_identity=''
        migration_unit_rename_completed=0
        return 0
      fi
      if ! mv -Tn -- "$backup_quarantine_path" "$unit_fs" || { [ -e "$backup_quarantine_path" ] || [ -L "$backup_quarantine_path" ]; }; then
        [ -n "$migration_unit_backup_fs" ] && mv -Tn -- "$backup_quarantine_path" "$migration_unit_backup_fs" 2>/dev/null && [ ! -e "$backup_quarantine_path" ] && [ ! -L "$backup_quarantine_path" ] && rmdir -- "$backup_quarantine_dir" 2>/dev/null || true
        printf '%s\n' "Refusing to restore migration system unit without overwriting a concurrent replacement: $unit_fs" >&2
        return 1
      fi
      rmdir -- "$backup_quarantine_dir" 2>/dev/null || true
      fsync_directory "$(dirname "$unit_fs")"
      migration_unit_backup_fs=''
      migration_unit_backup_identity=''
      migration_unit_published_identity=''
      migration_unit_rename_completed=0
      return 0
    fi
    printf '%s\n' "Refusing to restore over substituted migration system unit: $unit_fs" >&2
    return 1
  fi
  if [ "$migration_unit_had_file" = 1 ]; then
    if ! mv -Tn -- "$backup_quarantine_path" "$unit_fs" || { [ -e "$backup_quarantine_path" ] || [ -L "$backup_quarantine_path" ]; }; then
      printf '%s\n' "Refusing to restore migration system unit without overwriting a concurrent replacement: $unit_fs" >&2
      return 1
    fi
    if ! rmdir -- "$backup_quarantine_dir"; then
      printf '%s\n' "Refusing to leave an unverified migration system unit backup quarantine: $backup_quarantine_dir" >&2
      return 1
    fi
  fi
  if ! discard_owned_quarantine "$migration_unit_published_identity" file "migration system unit"; then
    return 1
  fi
  fsync_directory "$(dirname "$unit_fs")"
  migration_unit_backup_fs=''
  migration_unit_backup_identity=''
  migration_unit_published_identity=''
  migration_unit_rename_completed=0
}

record_migration_wants_publication() {
  [ "${mode:-}" = migrate ] || return 0
  [ -L "$migration_wants_fs" ] || return 0
  migration_wants_published_identity="$(publication_identity "$migration_wants_fs")"
  substitute_migration_test_entry wants "$migration_wants_fs"
  migration_checkpoint wants
}

restore_migration_wants_state() {
  local backup_quarantine_path='' backup_quarantine_dir=''
  [ -n "$migration_wants_published_identity" ] || return 0
  if [ "$migration_wants_had_entry" = 1 ]; then
    if ! quarantine_owned_path "$migration_wants_backup_fs" "$migration_wants_backup_identity" link "migration system wants backup for restore" migration-wants-backup-restore; then
      printf '%s\n' "Refusing to restore from substituted migration system wants backup: $migration_wants_backup_fs" >&2
      return 1
    fi
    backup_quarantine_path="$owned_quarantine_path"
    backup_quarantine_dir="$owned_quarantine_dir"
  fi
  local q_wants_status=0
  quarantine_owned_path "$migration_wants_fs" "$migration_wants_published_identity" link "migration system wants entry" || q_wants_status=$?
  if [ "$q_wants_status" -ne 0 ]; then
    if [ "$q_wants_status" -eq 2 ]; then
      if [ "$migration_wants_had_entry" = 0 ]; then
        migration_wants_published_identity=''
        migration_wants_backup_fs=''
        migration_wants_backup_identity=''
        return 0
      fi
      if ! mv -Tn -- "$backup_quarantine_path" "$migration_wants_fs" || { [ -e "$backup_quarantine_path" ] || [ -L "$backup_quarantine_path" ]; }; then
        [ -n "$migration_wants_backup_fs" ] && mv -Tn -- "$backup_quarantine_path" "$migration_wants_backup_fs" 2>/dev/null && [ ! -e "$backup_quarantine_path" ] && [ ! -L "$backup_quarantine_path" ] && rmdir -- "$backup_quarantine_dir" 2>/dev/null || true
        printf '%s\n' "Refusing to restore migration system wants entry without overwriting a concurrent replacement: $migration_wants_fs" >&2
        return 1
      fi
      rmdir -- "$backup_quarantine_dir" 2>/dev/null || true
      fsync_directory "$(dirname "$migration_wants_fs")"
      migration_wants_published_identity=''
      migration_wants_backup_fs=''
      migration_wants_backup_identity=''
      return 0
    fi
    printf '%s\n' "Refusing to restore substituted migration system wants entry: $migration_wants_fs" >&2
    return 1
  fi
  if [ "$migration_wants_had_entry" = 1 ]; then
    if ! mv -Tn -- "$backup_quarantine_path" "$migration_wants_fs" || { [ -e "$backup_quarantine_path" ] || [ -L "$backup_quarantine_path" ]; }; then
      printf '%s\n' "Refusing to restore migration system wants entry without overwriting a concurrent replacement: $migration_wants_fs" >&2
      return 1
    fi
    if ! rmdir -- "$backup_quarantine_dir"; then
      printf '%s\n' "Refusing to leave an unverified migration system wants backup quarantine: $backup_quarantine_dir" >&2
      return 1
    fi
  fi
  if ! discard_owned_quarantine "$migration_wants_published_identity" link "migration system wants entry"; then
    return 1
  fi
  fsync_directory "$(dirname "$migration_wants_fs")"
  migration_wants_published_identity=''
  migration_wants_backup_fs=''
  migration_wants_backup_identity=''
}

migration_wants_rollback_is_safe() {
  if [ -z "$migration_wants_published_identity" ]; then
    return 0
  fi
  if ! matches_publication_identity "$migration_wants_fs" "$migration_wants_published_identity"; then
    printf '%s\n' "Refusing to restore substituted migration system wants entry: $migration_wants_fs" >&2
    return 1
  fi
  return 0
}

complete_migration_unit_rollback() {
  if [ -n "$migration_unit_backup_fs" ]; then
    if ! quarantine_owned_path "$migration_unit_backup_fs" "$migration_unit_backup_identity" file "migration system unit backup" migration-unit-backup; then
      printf '%s\n' "Refusing to remove substituted migration system unit backup: $migration_unit_backup_fs" >&2
      return 1
    fi
    if ! discard_owned_quarantine "$migration_unit_backup_identity" file "migration system unit backup"; then
      return 1
    fi
    fsync_directory "$(dirname "$migration_unit_backup_fs")"
  fi
  migration_unit_backup_fs=''
  migration_unit_backup_identity=''
  migration_unit_published_identity=''
  migration_unit_rename_completed=0
  if [ -n "$migration_wants_backup_fs" ]; then
    if ! quarantine_owned_path "$migration_wants_backup_fs" "$migration_wants_backup_identity" link "migration system wants backup" migration-wants-backup; then
      printf '%s\n' "Refusing to remove substituted migration system wants backup: $migration_wants_backup_fs" >&2
      return 1
    fi
    if ! discard_owned_quarantine "$migration_wants_backup_identity" link "migration system wants backup"; then
      return 1
    fi
    fsync_directory "$(dirname "$migration_wants_backup_fs")"
  fi
  migration_wants_backup_fs=''
  migration_wants_backup_identity=''
  migration_wants_published_identity=''
}

cleanup_migration_unit_staging() {
  [ -n "$migration_unit_staging_fs" ] || return 0
  safe_cleanup_owned_path "$migration_unit_staging_fs" "$migration_unit_staging_identity" file "migration system unit staging file" migration-unit-staging || return
  migration_unit_staging_fs=''
  migration_unit_staging_identity=''
}

write_unit() {
  local release_fs="$1" unit_fs runtime_exec
  runtime_exec="$(unit_runtime_for "$release_fs")" || die "Release runtime is not executable: $release_fs"
  unit_fs="$(root_path "$unit_file")"
  install -d -m 0755 "$(dirname "$unit_fs")"
  migration_unit_staging_fs="${unit_fs}.migration-staging-${release_id}.$$"
  if [ -e "$migration_unit_staging_fs" ] || [ -L "$migration_unit_staging_fs" ]; then
    die "Migration system unit staging path already exists"
  fi
  if ! (umask 077 && set -C && : >"$migration_unit_staging_fs") 2>/dev/null; then
    die "Could not create migration system unit staging file"
  fi
  cat >"$migration_unit_staging_fs" <<EOF
[Unit]
Description=Antigravity Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user_name
Group=$service_group
EnvironmentFile=$env_file
WorkingDirectory=$current_link
ExecStart=$runtime_exec $current_link/dist/cli.js serve
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectKernelLogs=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid
LockPersonality=true
RestrictSUIDSGID=true
RestrictNamespaces=true
RestrictRealtime=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$data_dir
MemoryHigh=256M
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$migration_unit_staging_fs"
  require_regular_file "$migration_unit_staging_fs" "migration system unit staging file"
  migration_unit_staging_identity="$(publication_identity "$migration_unit_staging_fs")"
  if [ "${mode:-}" = migrate ]; then
    # Record this exact inode before rename so rollback never needs a post-publication observation.
    migration_unit_published_identity="$migration_unit_staging_identity"
    migration_checkpoint unit-stage
  fi
  mv -Tf -- "$migration_unit_staging_fs" "$unit_fs"
  migration_unit_staging_fs=''
  migration_unit_staging_identity=''
  fsync_directory "$(dirname "$unit_fs")"
  if [ "${mode:-}" = migrate ]; then
    migration_unit_rename_completed=1
    substitute_migration_test_entry unit "$unit_fs"
    migration_checkpoint unit-rename
  fi
}

release_runtime_relative_path() {
  local release_path="$1" relative_path release_resolved runtime_resolved
  if [ "$bundle_node" = 1 ]; then
    release_resolved="$(readlink -f -- "$release_path")" || return 1
    [ -d "$release_resolved" ] || return 1
    for relative_path in bin/node runtime/node; do
      if [ -x "$release_path/$relative_path" ]; then
        runtime_resolved="$(readlink -f -- "$release_path/$relative_path")" || return 1
        if ! { [ -f "$runtime_resolved" ] && [ -x "$runtime_resolved" ]; }; then
          continue
        fi
        case "$runtime_resolved" in
          "$release_resolved"/*)
            printf '%s\n' "$relative_path"
            return
            ;;
          *)
            printf 'Bundled runtime escapes verified release directory: %s\n' "$release_path/$relative_path" >&2
            return 1
            ;;
        esac
      fi
    done
    return 1
  fi
}

release_runtime_for() {
  local release_path="$1" relative_path
  if [ "$bundle_node" = 1 ]; then
    relative_path="$(release_runtime_relative_path "$release_path")" || return
    printf '%s/%s\n' "$release_path" "$relative_path"
  else
    printf '%s\n' "$node_binary"
  fi
}

unit_runtime_for() {
  local release_path="$1" relative_path
  if [ "$bundle_node" = 1 ]; then
    relative_path="$(release_runtime_relative_path "$release_path")" || return
    printf '%s/%s\n' "$current_link" "$relative_path"
  else
    printf '%s\n' "$node_binary"
  fi
}

release_path_for_id() {
  local target_id="$1" release_fs
  validate_release_id "$target_id"
  release_fs="$(root_path "$releases_dir/$target_id")"
  if ! { [ -d "$release_fs" ] && [ ! -L "$release_fs" ]; }; then
    printf 'Release directory is missing or unsafe: %s\n' "$release_fs" >&2
    return 1
  fi
  printf '%s\n' "$release_fs"
}

validate_release_runtime() {
  local target_id="$1" release_fs runtime
  release_fs="$(release_path_for_id "$target_id")" || die "Release $target_id is not a verified immutable release"
  runtime="$(release_runtime_for "$release_fs")" || die "Release $target_id has no executable bundled runtime"
  if ! { [ -f "$runtime" ] && [ -x "$runtime" ]; }; then
    die "Release runtime is not executable: $runtime"
  fi
}

write_unit_for_release() {
  local target_id="$1" release_fs
  validate_release_runtime "$target_id"
  release_fs="$(release_path_for_id "$target_id")" || die "Release $target_id is not a verified immutable release"
  write_unit "$release_fs"
}

run_release_probe_command() {
  if is_simulated; then
    "$@"
  else
    runuser -u "$user_name" -- "$@"
  fi
}

release_runtime_probe() {
  local release_fs runtime cli_output cli_status
  release_fs="$candidate_staging_fs"
  [ -n "$release_fs" ] || release_fs="$(root_path "$release_dir")"
  if is_simulated && [ "${RELEASE_TEST_RUNTIME_PROBE:-pass}" != pass ]; then
    die "Release runtime probe was forced to fail for a hermetic test"
  fi
  runtime="$(release_runtime_for "$release_fs")"
  [ -x "$runtime" ] || die "Release runtime is not executable: $runtime"
  if [ -n "${RELEASE_TEST_PROBE_LOG:-}" ]; then
    printf 'uid=%s command=%s %s release-runtime-probe\n' "$(id -u)" "$runtime" "$release_fs/dist/cli.js" >>"$RELEASE_TEST_PROBE_LOG"
  fi
  (
    cd "$release_fs"
    run_release_probe_command "$runtime" --input-type=module -e "const Database=(await import('better-sqlite3')).default; const db=new Database(':memory:'); db.exec('SELECT 1'); db.close()"
  ) || die "Release runtime could not load better-sqlite3"
  cli_status=0
  cli_output="$(run_release_probe_command "$runtime" "$release_fs/dist/cli.js" release-runtime-probe 2>&1)" || cli_status=$?
  if [ "$cli_status" -ne 1 ] || ! printf '%s' "$cli_output" | grep -Fq 'Usage:'; then
    die "Release runtime could not load the built CLI"
  fi
}

validate_environment_contract() {
  local env_fs="${1:-$(root_path "$env_file")}" line value required count
  require_regular_file "$env_fs" "environment file"
  for required in AG_PROXY_HOST AG_PROXY_PORT AG_PROXY_DATA_DIR AG_PROXY_API_KEY AG_PROXY_ADMIN_API_KEY; do
    count=0
    value=''
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$required"=*)
          count=$((count + 1))
          value="${line#*=}"
          ;;
      esac
    done <"$env_fs"
    [ "$count" -eq 1 ] || die "Environment contract has missing or duplicate $required"
    [ -n "$value" ] || die "Environment contract has an empty $required"
    case "$value" in
      *[[:space:]]*|*'"'*|*"'"*|*\\*) die "Environment contract has a malformed $required" ;;
    esac
  done
  value="$(sed -n 's/^AG_PROXY_DATA_DIR=//p' "$env_fs")"
  [ "$value" = "$data_dir" ] || die "Environment contract AG_PROXY_DATA_DIR does not match DATA_DIR"
  case "$(sed -n 's/^AG_PROXY_PORT=//p' "$env_fs")" in
    *[!0-9]*|'') die "Environment contract has a malformed AG_PROXY_PORT" ;;
  esac
}

systemd() {
  if is_simulated && [ -n "$migration_wants_fs" ] && [ "$1" = enable ] && [ "$2" = --now ] && [ "$3" = antigravity-proxy.service ] && [ ! -e "$migration_wants_fs" ] && [ ! -L "$migration_wants_fs" ]; then
    install -d -m 0755 "$(dirname "$migration_wants_fs")"
    ln -s ../antigravity-proxy.service "$migration_wants_fs"
  fi
  if [ -n "${RELEASE_TEST_SYSTEMD_LOG:-}" ]; then
    printf '%s\n' "$*" >>"$RELEASE_TEST_SYSTEMD_LOG"
  fi
  if is_simulated && [ "${RELEASE_TEST_SMOKE:-pass}" != real ] && [ "${RELEASE_TEST_SYSTEMCTL:-0}" != 1 ]; then
    return 0
  fi
  systemctl "$@"
}

smoke_check() {
  if is_simulated && [ "${RELEASE_TEST_SMOKE:-pass}" != real ]; then
    migration_smoke_check_count=$((migration_smoke_check_count + 1))
    case "${RELEASE_TEST_SMOKE:-pass}" in
      pass) return 0 ;;
      fail) return 1 ;;
      fail-first) [ "$migration_smoke_check_count" -ne 1 ]; return ;;
      fail-restored) [ "$migration_smoke_check_count" -ne 2 ]; return ;;
      *) die "Unknown RELEASE_TEST_SMOKE mode: $RELEASE_TEST_SMOKE" ;;
    esac
  fi

  local host port base_url admin_status listener main_pid service_user env_fs
  env_fs="$(root_path "$env_file")"
  [ -f "$env_fs" ] || { printf 'Environment file is missing: %s\n' "$env_fs" >&2; return 1; }
  host="$(sed -n 's/^AG_PROXY_HOST=//p' "$env_fs" | tail -n 1)"
  port="$(sed -n 's/^AG_PROXY_PORT=//p' "$env_fs" | tail -n 1)"
  if [ -z "$host" ] || [ -z "$port" ]; then
    printf 'Environment file lacks AG_PROXY_HOST or AG_PROXY_PORT: %s\n' "$env_fs" >&2; return 1
  fi
  base_url="http://$host:$port"

  local timeout_secs="${SMOKE_TIMEOUT_SECS:-15}"
  local request_timeout="${SMOKE_REQUEST_TIMEOUT_SECS:-2}"
  local poll_interval="${SMOKE_POLL_INTERVAL_SECS:-0.1}"
  case "$timeout_secs" in ''|*[!0-9]*) timeout_secs=15 ;; esac
  case "$request_timeout" in ''|*[!0-9]*) request_timeout=2 ;; esac

  local health_code='000' ready=0 curl_exit=0 active_state='' start_time current_time elapsed
  start_time="$(date +%s)"

  while true; do
    active_state="$(systemd show --property=ActiveState --value antigravity-proxy.service 2>/dev/null || true)"
    if [ "$active_state" = failed ]; then
      printf 'Systemd service entered failed state during startup\n' >&2; return 1
    fi

    curl_exit=0
    health_tmp="$(mktemp)"
    health_code="$(curl -q --noproxy '*' --silent --max-time "$request_timeout" --write-out '%{http_code}' --output "$health_tmp" "$base_url/health" 2>/dev/null)" || curl_exit=$?
    health_body="$(cat "$health_tmp" 2>/dev/null || true)"; rm -f "$health_tmp"

    if [ "$curl_exit" -eq 0 ] && [ "$health_code" = 200 ]; then
      if [ -z "$health_body" ]; then
        printf 'Health endpoint responded 200 with empty body\n' >&2; return 1
      fi
      if ! node -e 'const r=process.argv[1]; try { const p=JSON.parse(r); process.exit(p&&p.ok===true&&p.connect_ready===true?0:1); } catch { process.exit(1); }' "$health_body"; then
        printf 'Health endpoint response failed validation (expected {ok:true, connect_ready:true}): %s\n' "$health_body" >&2; return 1
      fi
      ready=1; break
    fi

    # Tolerated transient startup states while PID initializes:
    if [ "$curl_exit" -eq 7 ] || [ "$curl_exit" -eq 28 ] || [ "$curl_exit" -eq 52 ] || [ "$curl_exit" -eq 56 ] || [ "$health_code" = '000' ]; then
      current_time="$(date +%s)"; elapsed=$((current_time - start_time))
      if [ "$elapsed" -ge "$timeout_secs" ]; then break; fi
      sleep "$poll_interval"; continue
    fi

    printf 'Health endpoint returned unexpected HTTP status %s (curl exit %s, body: %s)\n' "$health_code" "$curl_exit" "$health_body" >&2
    return 1
  done

  if [ "$ready" -ne 1 ]; then
    printf 'Startup readiness timed out after %s seconds (last HTTP %s, curl exit %s)\n' "$timeout_secs" "$health_code" "$curl_exit" >&2
    return 1
  fi

  admin_status="$(curl -q --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time "$request_timeout" "$base_url/admin/status" 2>/dev/null || printf '000')"
  case "$admin_status" in 401|403) ;; *) printf 'Unauthenticated admin endpoint returned unexpected HTTP %s\n' "$admin_status" >&2; return 1 ;; esac

  listener="$(ss -ltnH "( sport = :$port )" 2>/dev/null || true)"
  printf '%s\n' "$listener" | grep -Fq "$host:$port" || { printf 'Expected listener %s:%s is absent from listening sockets\n' "$host" "$port" >&2; return 1; }

  main_pid="$(systemd show --property=MainPID --value antigravity-proxy.service 2>/dev/null || true)"
  case "$main_pid" in ''|0|*[!0-9]*) printf 'Systemd did not report a running MainPID: %s\n' "$main_pid" >&2; return 1 ;; esac

  listener="$(ss -ltnpH "( sport = :$port )" 2>/dev/null || true)"
  printf '%s\n' "$listener" | grep -Fq "$host:$port" || { printf 'Expected listener %s:%s is absent from listening sockets with PID info\n' "$host" "$port" >&2; return 1; }
  printf '%s\n' "$listener" | grep -Fq "pid=$main_pid," || { printf 'Systemd MainPID %s does not own listener %s:%s\n' "$main_pid" "$host" "$port" >&2; return 1; }

  systemd is-enabled --quiet antigravity-proxy.service || { printf 'Antigravity Proxy service is not enabled in systemd\n' >&2; return 1; }
  systemd is-active --quiet antigravity-proxy.service || { printf 'Antigravity Proxy service is not active in systemd\n' >&2; return 1; }

  service_user="$(systemd show --property=User --value antigravity-proxy.service 2>/dev/null || true)"
  [ "$service_user" = "$user_name" ] || { printf 'Systemd service user %s does not match expected user %s\n' "$service_user" "$user_name" >&2; return 1; }

  local ca_cert_file="/usr/local/share/antigravity-proxy/ca.crt"
  [ -s "$ca_cert_file" ] || ca_cert_file="$(root_path "$data_dir")/certs/ca.crt"
  [ -s "$ca_cert_file" ] || { printf 'Expected CA certificate file is missing or empty: %s\n' "$ca_cert_file" >&2; return 1; }
  local connect_probe_exit=0
  curl -q --silent --max-time "$request_timeout" --proxy "http://$host:$port" --noproxy '' --cacert "$ca_cert_file" --output /dev/null "https://cloudcode-pa.googleapis.com" 2>/dev/null || connect_probe_exit=$?
  if [ "$connect_probe_exit" -ne 0 ]; then
    printf 'CONNECT TLS probe failed (curl exit %s)\n' "$connect_probe_exit" >&2; return 1
  fi

  return 0
}

activate_release() {
  local action="$1"
  systemd daemon-reload || return 1
  if [ "$action" = start ]; then
    systemd enable --now antigravity-proxy.service || return 1
    record_migration_wants_publication
  else
    systemd restart antigravity-proxy.service || return 1
  fi
  smoke_check
}

validate_migration_set() {
  local legacy_dir="${LEGACY_DATA_DIR:-}" legacy_env="${LEGACY_ENV_FILE:-}" legacy_fs legacy_env_fs data_fs env_fs install_fs releases_fs unit_fs file
  [ -n "$legacy_dir" ] || die "migrate requires LEGACY_DATA_DIR"
  require_absolute_path "$legacy_dir" LEGACY_DATA_DIR
  legacy_fs="$(root_path "$legacy_dir")"
  data_fs="$(root_path "$data_dir")"
  env_fs="$(root_path "$env_file")"
  install_fs="$(root_path "$install_root")"
  releases_fs="$(root_path "$releases_dir")"
  unit_fs="$(root_path "$unit_file")"
  validate_existing_parent_directories "$install_fs" "install root"
  validate_existing_parent_directories "$releases_fs" "releases directory"
  validate_existing_parent_directories "$data_fs" "persistent state directory"
  validate_existing_parent_directories "$env_fs" "environment file"
  validate_existing_parent_directories "$unit_fs" "system unit"
  validate_existing_parent_directories "$legacy_fs" "legacy state directory"
  if [ -e "$install_fs" ] || [ -L "$install_fs" ]; then
    require_safe_directory "$install_fs" "install root" 0755
  fi
  if [ -e "$releases_fs" ] || [ -L "$releases_fs" ]; then
    require_safe_directory "$releases_fs" "releases directory" 0755
  fi
  if [ -e "$(root_path "$release_dir")" ] || [ -L "$(root_path "$release_dir")" ]; then
    die "Release already exists: $release_dir"
  fi
  if ! { [ -d "$legacy_fs" ] && [ ! -L "$legacy_fs" ]; }; then
    die "Legacy state directory does not exist: $legacy_dir"
  fi
  validate_state_topology "$legacy_fs" "legacy migration state"
  validate_state_topology "$data_fs" "target migration state"
  while IFS= read -r file; do
    if [ -e "$legacy_fs/$file" ]; then
      require_regular_file "$legacy_fs/$file" "legacy migration $file"
      [ -r "$legacy_fs/$file" ] || die "legacy migration $file must be readable"
    fi
  done < <(migration_state_entries)
  for file in accounts.db .master-key; do
    require_regular_file "$legacy_fs/$file" "legacy migration $file"
  done
  if [ ! -f "$env_fs" ]; then
    [ -n "$legacy_env" ] || die "migrate requires LEGACY_ENV_FILE when the target environment is absent"
    require_absolute_path "$legacy_env" LEGACY_ENV_FILE
    legacy_env_fs="$(root_path "$legacy_env")"
    validate_existing_parent_directories "$legacy_env_fs" "legacy environment file"
    require_regular_file "$legacy_env_fs" "legacy environment file"
    [ -r "$legacy_env_fs" ] || die "legacy environment file must be readable"
    validate_environment_contract "$legacy_env_fs"
  fi
  if [ -e "$env_fs" ] || [ -L "$env_fs" ]; then
    require_regular_file "$env_fs" "target environment file"
    validate_environment_contract "$env_fs"
  fi
  while IFS= read -r file; do
    if [ -e "$data_fs/$file" ] || [ -L "$data_fs/$file" ]; then
      die "Target migration state is not empty; use update for an already-migrated target"
    fi
  done < <(migration_state_entries)
}

# shellcheck disable=SC2034 # migration_topology is consumed by the installer that sources this library.
capture_migration_topology() {
  local system_active legacy_active
  if is_simulated; then
    system_active="${RELEASE_TEST_SYSTEM_ACTIVE:-0}"
    legacy_active="${RELEASE_TEST_LEGACY_ACTIVE:-1}"
  else
    system_active=0
    legacy_active=0
    if systemd is-active --quiet antigravity-proxy.service; then
      system_active=1
    fi
    if legacy_user_systemd is-active --quiet; then
      legacy_active=1
    fi
  fi
  case "$system_active:$legacy_active" in
    1:0) migration_topology=system-only ;;
    0:1) migration_topology=legacy-only ;;
    1:1) die "Migration refused: both legacy and system services are active" ;;
    0:0) migration_topology=neither ;;
    *) die "Migration refused: invalid service topology state" ;;
  esac
  # shellcheck disable=SC2034 # consumed by the installer that sources this library.
  migration_system_was_active="$system_active"
  # shellcheck disable=SC2034 # consumed by the installer that sources this library.
  migration_legacy_was_active="$legacy_active"
}

stage_legacy_migration_set() {
  local legacy_dir="${LEGACY_DATA_DIR:-}" legacy_env="${LEGACY_ENV_FILE:-}" legacy_fs data_fs env_fs file stage_fs
  legacy_fs="$(root_path "$legacy_dir")"
  data_fs="$(root_path "$data_dir")"
  env_fs="$(root_path "$env_file")"
  stage_fs="$data_fs/.migration-staging-${release_id}.$$"
  if [ -e "$stage_fs" ] || [ -L "$stage_fs" ]; then
    die "Migration state staging path already exists"
  fi
  mkdir -m 0700 "$stage_fs"
  migration_state_staging_fs="$stage_fs"
  migration_state_staging_identity="$(publication_identity "$stage_fs")"
  while IFS= read -r file; do
    if [ -e "$legacy_fs/$file" ]; then
      copy_regular_file "$legacy_fs/$file" "$stage_fs/$file" 0600 "legacy migration $file"
    fi
  done < <(migration_state_entries)
  validate_state_topology "$stage_fs" "staged migration state"
  migration_state_staging_identity="$(publication_identity "$stage_fs")"
  if ! { [ -e "$env_fs" ] || [ -L "$env_fs" ]; }; then
    migration_environment_staging_fs="${env_fs}.migration-staging-${release_id}.$$"
    if [ -e "$migration_environment_staging_fs" ] || [ -L "$migration_environment_staging_fs" ]; then
      die "Migration environment staging path already exists"
    fi
    copy_regular_file "$(root_path "$legacy_env")" "$migration_environment_staging_fs" 0640 "legacy environment"
    validate_environment_contract "$migration_environment_staging_fs"
    migration_environment_staging_identity="$(publication_identity "$migration_environment_staging_fs")"
  fi
}

migration_checkpoint() {
  local name="$1"
  if is_simulated && [ "${RELEASE_TEST_MIGRATION_FAIL_AFTER:-}" = "$name" ]; then
    die "Migration failure was forced after $name"
  fi
}

substitute_migration_test_entry() {
  local checkpoint="$1" target_fs="$2"
  if is_simulated && [ "${RELEASE_TEST_MIGRATION_SUBSTITUTE_AFTER:-}" = "$checkpoint" ]; then
    if [ -d "$target_fs" ] && [ ! -L "$target_fs" ]; then
      rm -rf -- "$target_fs"
      mkdir -- "$target_fs"
      printf '%s\n' substituted >"$target_fs/replacement"
    else
      rm -- "$target_fs"
      printf '%s\n' substituted >"$target_fs"
    fi
  fi
}

substitute_cleanup_test_entry() {
  local checkpoint="$1" target_fs="$2" kind="${RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND:-directory}"
  if is_simulated && [ "${RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER:-}" = "$checkpoint" ]; then
    case "$kind" in
      directory)
        mkdir -- "$target_fs"
        printf '%s\n' substituted >"$target_fs/replacement"
        ;;
      file) printf '%s\n' substituted >"$target_fs" ;;
      symlink) ln -s /retained-cleanup-substitution "$target_fs" ;;
      *) die "Unknown cleanup substitution kind: $kind" ;;
    esac
  fi
}

publish_staged_migration_file() {
  local stage_fs="$1" target_fs="$2" label="$3"
  if [ -e "$target_fs" ] || [ -L "$target_fs" ]; then
    die "$label target already exists"
  fi
  mv -n -- "$stage_fs" "$target_fs"
  if [ -e "$stage_fs" ] || [ -L "$stage_fs" ]; then
    die "Could not publish staged $label without overwriting a target"
  fi
  require_regular_file "$target_fs" "$label target"
  record_migration_publication "$target_fs"
}

publish_staged_migration_set() {
  local data_fs env_fs file
  data_fs="$(root_path "$data_dir")"
  env_fs="$(root_path "$env_file")"
  if [ -n "$migration_environment_staging_fs" ]; then
    publish_staged_migration_file "$migration_environment_staging_fs" "$env_fs" "legacy environment"
    migration_environment_staging_fs=''
    substitute_migration_test_entry environment "$env_fs"
    migration_checkpoint environment
  fi
  while IFS= read -r file; do
    if [ -e "$migration_state_staging_fs/$file" ]; then
      publish_staged_migration_file "$migration_state_staging_fs/$file" "$data_fs/$file" "legacy migration $file"
      substitute_migration_test_entry "state-$file" "$data_fs/$file"
      migration_checkpoint "state-$file"
    fi
  done < <(migration_state_entries)
  migration_state_staging_identity="$(publication_identity "$migration_state_staging_fs")"
  safe_cleanup_owned_path "$migration_state_staging_fs" "$migration_state_staging_identity" directory "successful migration state staging directory" migration-state-staging-success || return
  migration_state_staging_fs=''
  migration_state_staging_identity=''
  validate_state_topology "$data_fs" "copied migration state"
}

legacy_user_systemd() {
  local legacy_user="${LEGACY_SERVICE_USER:-}" legacy_unit="${LEGACY_USER_UNIT:-antigravity-proxy.service}" uid runtime_dir
  if is_simulated; then
    if [ -n "${RELEASE_TEST_LEGACY_LOG:-}" ]; then
      printf '%s %s\n' "$*" "$legacy_unit" >>"$RELEASE_TEST_LEGACY_LOG"
    fi
    if [ "$1" = disable ] && [ "${RELEASE_TEST_LEGACY_DISABLE:-pass}" = fail ]; then
      return 1
    fi
    return 0
  fi
  [ -n "$legacy_user" ] || die "migrate requires LEGACY_SERVICE_USER"
  uid="$(id -u "$legacy_user")"
  runtime_dir="/run/user/$uid"
  [ -d "$runtime_dir" ] || die "Legacy user runtime directory is unavailable: $runtime_dir"
  runuser -u "$legacy_user" -- env XDG_RUNTIME_DIR="$runtime_dir" systemctl --user "$@" "$legacy_unit"
}
