#!/usr/bin/env bash
# Runtime discovery helpers sourced by release-lib.sh.

path_is_within() {
  local path="$1" root="$2"
  [ "$path" = "$root" ] || [[ "$path" == "$root"/* ]]
}

canonical_runtime_binary() {
  local candidate="$1" label="$2"
  require_absolute_path "$candidate" "$label"
  if ! { [ -f "$candidate" ] && [ -x "$candidate" ] && [ -r "$candidate" ]; }; then
    die "$label is not an executable regular file: $candidate"
  fi
  readlink -f -- "$candidate"
}

validate_runtime_root() {
  local runtime_root="$1" label="$2" owner_uid project_resolved
  if ! { [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; }; then
    die "$label must be a real directory: $runtime_root"
  fi
  runtime_root="$(readlink -f -- "$runtime_root")"
  project_resolved="$(readlink -f -- "$project_dir")"
  if path_is_within "$runtime_root" "$project_resolved"; then
    die "$label must not be inside the project directory"
  fi
  if [ -n "$release_operator" ]; then
    owner_uid="$(id -u "$release_operator" 2>/dev/null)" || die "RELEASE_OPERATOR does not exist: $release_operator"
    [ "$(stat -c '%u' -- "$runtime_root")" = "$owner_uid" ] || die "$label must be owned by RELEASE_OPERATOR"
  fi
  printf '%s\n' "$runtime_root"
}

resolve_release_runtime() {
  local node_candidate npm_candidate runtime_root node_dir node_install_root
  if [ -n "${NODE_BINARY:-}" ]; then
    node_candidate="$NODE_BINARY"
    node_binary="$(canonical_runtime_binary "$node_candidate" NODE_BINARY)"
    runtime_root="$(validate_runtime_root "$(dirname "$(dirname "$node_binary")")" "NODE_BINARY runtime root")"
  elif node_candidate="$(command -v node || true)" && [ -n "$node_candidate" ]; then
    node_binary="$(canonical_runtime_binary "$node_candidate" NODE_BINARY)"
    runtime_root="$(validate_runtime_root "$(dirname "$(dirname "$node_binary")")" "NODE_BINARY runtime root")"
  else
    [ -n "${FNM_DIR:-}" ] || die "Node runtime not found; set NODE_BINARY to an executable absolute path"
    require_absolute_path "$FNM_DIR" FNM_DIR
    runtime_root="$(validate_runtime_root "$FNM_DIR" FNM_DIR)"
    node_binary="$(canonical_runtime_binary "$runtime_root/aliases/default/bin/node" NODE_BINARY)"
  fi
  path_is_within "$node_binary" "$runtime_root" || die "NODE_BINARY escapes its validated runtime root"
  node_dir="$(dirname "$node_binary")"
  node_install_root="$(validate_runtime_root "$(dirname "$node_dir")" "NODE_BINARY runtime installation")"
  if [ -n "${NPM_BINARY:-}" ]; then
    npm_candidate="$NPM_BINARY"
    npm_binary="$(canonical_runtime_binary "$npm_candidate" NPM_BINARY)"
  else
    npm_binary="$(canonical_runtime_binary "$node_dir/npm" NPM_BINARY)"
  fi
  path_is_within "$npm_binary" "$node_install_root" || die "NPM_BINARY must be in the same runtime installation as NODE_BINARY"
  path_is_within "$npm_binary" "$runtime_root" || die "NPM_BINARY escapes its validated runtime root"
  node_runtime_bin="$node_dir"
}
