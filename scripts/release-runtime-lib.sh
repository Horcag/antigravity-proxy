#!/usr/bin/env bash
# Runtime discovery helpers sourced by release-lib.sh.

path_is_within() {
  local path="$1" root="$2"
  [ "$path" = "$root" ] || [[ "$path" == "$root"/* ]]
}

canonical_runtime_binary() {
  local candidate="$1" label="$2" resolved
  require_absolute_path "$candidate" "$label"
  if ! { [ -f "$candidate" ] && [ -x "$candidate" ] && [ -r "$candidate" ]; }; then
    die "$label is not an executable regular file: $candidate"
  fi
  resolved="$(readlink -f -- "$candidate")"
  if ! { [ -f "$resolved" ] && [ -x "$resolved" ] && [ -r "$resolved" ]; }; then
    die "$label is not an executable regular file: $candidate"
  fi
  printf '%s\n' "$resolved"
}

runtime_path_is_secure() {
  local path="$1" label="$2" expected_uid="$3" mode
  if ! { [ -e "$path" ] && [ ! -L "$path" ]; }; then
    die "$label must not be a symlink: $path"
  fi
  [ "$(stat -c '%u' -- "$path")" = "$expected_uid" ] || die "$label has an unexpected owner: $path"
  mode=$((8#$(stat -c '%a' -- "$path")))
  (( (mode & 0022) == 0 )) || die "$label must not be group- or world-writable: $path"
}

validate_runtime_root() {
  local runtime_root="$1" label="$2" project_resolved
  if ! { [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; }; then
    die "$label must be a real directory: $runtime_root"
  fi
  runtime_root="$(readlink -f -- "$runtime_root")"
  project_resolved="$(readlink -f -- "$project_dir")"
  if path_is_within "$runtime_root" "$project_resolved"; then
    die "$label must not be inside the project directory"
  fi
  printf '%s\n' "$runtime_root"
}

validate_operator_runtime_root() {
  local runtime_root="$1" label="$2" operator_uid
  [ -n "$release_operator" ] || die "$label requires RELEASE_OPERATOR or SUDO_USER"
  operator_uid="$(id -u "$release_operator" 2>/dev/null)" || die "RELEASE_OPERATOR does not exist: $release_operator"
  runtime_root="$(validate_runtime_root "$runtime_root" "$label")"
  runtime_path_is_secure "$runtime_root" "$label" "$operator_uid"
  printf '%s\n' "$runtime_root"
}

validate_trusted_system_runtime_root() {
  local runtime_root="$1" label="$2"
  runtime_root="$(validate_runtime_root "$runtime_root" "$label")"
  case "$runtime_root" in /usr|/usr/*|/opt|/opt/*) ;; *) die "$label is not under a trusted system prefix: $runtime_root" ;; esac
  runtime_path_is_secure "$runtime_root" "$label" 0
  printf '%s\n' "$runtime_root"
}

runtime_owner_is_operator() {
  local path="$1" operator_uid
  [ -n "$release_operator" ] || return 1
  operator_uid="$(id -u "$release_operator" 2>/dev/null)" || die "RELEASE_OPERATOR does not exist: $release_operator"
  [ "$(stat -c '%u' -- "$path")" = "$operator_uid" ]
}

runtime_owner_is_current_user() {
  [ "$(stat -c '%u' -- "$1")" = "$(id -u)" ]
}

validate_runtime_binaries() {
  local kind="$1" owner_uid
  [ "$kind" = explicit-test ] && return
  if [ "$kind" = operator ]; then
    owner_uid="$(id -u "$release_operator")"
  elif [ "$kind" = current-user ]; then
    owner_uid="$(id -u)"
  else
    owner_uid=0
  fi
  runtime_path_is_secure "$node_dir" "NODE_BINARY parent" "$owner_uid"
  runtime_path_is_secure "$node_binary" NODE_BINARY "$owner_uid"
  runtime_path_is_secure "$npm_binary" NPM_BINARY "$owner_uid"
}

resolve_runtime_from_node() {
  local candidate="$1" kind="$2" node_candidate npm_candidate
  node_candidate="$candidate"
  node_binary="$(canonical_runtime_binary "$node_candidate" NODE_BINARY)"
  node_dir="$(dirname "$node_binary")"
  node_install_root="$(dirname "$node_dir")"
  if [ "$kind" = operator ]; then
    runtime_root="$(validate_operator_runtime_root "$(dirname "$node_install_root")" "NODE_BINARY runtime root")"
  elif [ "$kind" = explicit-test ]; then
    runtime_root="$(validate_runtime_root "$(dirname "$node_install_root")" "NODE_BINARY runtime root")"
  elif [ "$kind" = current-user ]; then
    runtime_root="$(validate_runtime_root "$(dirname "$node_install_root")" "NODE_BINARY runtime root")"
    runtime_path_is_secure "$runtime_root" "NODE_BINARY runtime root" "$(id -u)"
  else
    runtime_root="$(validate_trusted_system_runtime_root "$(dirname "$node_install_root")" "NODE_BINARY runtime root")"
  fi
  path_is_within "$node_binary" "$runtime_root" || die "NODE_BINARY escapes its validated runtime root"
  if [ -n "${NPM_BINARY:-}" ]; then
    npm_candidate="$NPM_BINARY"
    npm_binary="$(canonical_runtime_binary "$npm_candidate" NPM_BINARY)"
  else
    npm_binary="$(canonical_runtime_binary "$node_dir/npm" NPM_BINARY)"
  fi
  path_is_within "$npm_binary" "$node_install_root" || die "NPM_BINARY must be in the same runtime installation as NODE_BINARY"
  path_is_within "$npm_binary" "$runtime_root" || die "NPM_BINARY escapes its validated runtime root"
  validate_runtime_binaries "$kind"
}

resolve_operator_fnm_runtime() {
  local fnm_root="$1" source_label="$2" node_version_dir operator_uid
  fnm_root="$(validate_operator_runtime_root "$fnm_root" "$source_label")"
  node_binary="$(canonical_runtime_binary "$fnm_root/aliases/default/bin/node" NODE_BINARY)"
  node_dir="$(dirname "$node_binary")"
  node_install_root="$(dirname "$node_dir")"
  node_version_dir="$(dirname "$node_install_root")"
  [ "$(dirname "$node_version_dir")" = "$fnm_root/node-versions" ] || die "NODE_BINARY is not in the default fnm runtime"
  [ "$(basename "$node_install_root")" = installation ] || die "NODE_BINARY is not in the default fnm runtime"
  [ "$(basename "$node_dir")" = bin ] || die "NODE_BINARY is not in the default fnm runtime"
  operator_uid="$(id -u "$release_operator")"
  runtime_path_is_secure "$fnm_root/node-versions" "fnm node-versions directory" "$operator_uid"
  runtime_path_is_secure "$node_version_dir" "fnm version directory" "$operator_uid"
  runtime_path_is_secure "$node_install_root" "fnm installation directory" "$operator_uid"
  runtime_root="$fnm_root"
  if [ -n "${NPM_BINARY:-}" ]; then
    npm_binary="$(canonical_runtime_binary "$NPM_BINARY" NPM_BINARY)"
  else
    npm_binary="$(canonical_runtime_binary "$node_dir/npm" NPM_BINARY)"
  fi
  path_is_within "$npm_binary" "$node_install_root" || die "NPM_BINARY must be in the same runtime installation as NODE_BINARY"
  path_is_within "$npm_binary" "$fnm_root" || die "NPM_BINARY escapes its validated runtime root"
  validate_runtime_binaries operator
}

operator_fnm_dir() {
  local operator_home
  operator_home="$(getent passwd "$release_operator" | cut -d: -f6)"
  case "$operator_home" in /*) printf '%s/.local/share/fnm\n' "$operator_home" ;; *) return 1 ;; esac
}

resolve_release_runtime() {
  local node_candidate derived_fnm_dir
  if [ -n "${NODE_BINARY:-}" ]; then
    node_binary="$(canonical_runtime_binary "$NODE_BINARY" NODE_BINARY)"
    if runtime_owner_is_operator "$node_binary"; then
      resolve_runtime_from_node "$node_binary" operator
    elif [ "$test_mode" = 1 ]; then
      resolve_runtime_from_node "$node_binary" explicit-test
    else
      resolve_runtime_from_node "$node_binary" system
    fi
  elif [ -n "${FNM_DIR:-}" ]; then
    require_absolute_path "$FNM_DIR" FNM_DIR
    resolve_operator_fnm_runtime "$FNM_DIR" FNM_DIR
  elif [ -n "$release_operator" ] && derived_fnm_dir="$(operator_fnm_dir)" && [ -d "$derived_fnm_dir" ]; then
    resolve_operator_fnm_runtime "$derived_fnm_dir" "operator fnm directory"
  elif node_candidate="$(command -v node || true)" && [ -n "$node_candidate" ]; then
    node_binary="$(canonical_runtime_binary "$node_candidate" NODE_BINARY)"
    if [ "$dry_run" = 1 ]; then
      resolve_runtime_from_node "$node_binary" explicit-test
    elif runtime_owner_is_current_user "$node_binary"; then
      resolve_runtime_from_node "$node_binary" current-user
    else
      resolve_runtime_from_node "$node_binary" system
    fi
  else
    die "Node runtime not found; set NODE_BINARY or install a trusted system Node runtime"
  fi
  node_runtime_bin="$node_dir"
}

stage_release_dependencies_as_operator() {
  local operator_home staging_fs="$candidate_staging_fs"
  [ -n "$release_operator" ] || die "Set RELEASE_OPERATOR to the non-root operator that stages production dependencies"
  id "$release_operator" >/dev/null 2>&1 || die "RELEASE_OPERATOR does not exist: $release_operator"
  operator_home="$(getent passwd "$release_operator" | cut -d: -f6)"
  case "$operator_home" in /*) ;; *) die "RELEASE_OPERATOR home directory is invalid" ;; esac
  [ "$test_mode" = 1 ] || chown "$release_operator:$(id -gn "$release_operator")" "$staging_fs"
  runuser -u "$release_operator" -- env HOME="$operator_home" PATH="$node_runtime_bin:/usr/local/bin:/usr/bin:/bin" npm_config_cache="$staging_fs/.npm-cache" "$npm_binary" ci --prefix "$staging_fs" --omit=dev
}
