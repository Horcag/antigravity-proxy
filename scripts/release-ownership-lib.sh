#!/usr/bin/env bash
# Retained references are acquired only behind an owner-controlled parent boundary.
# Never call acquisition in command substitution: the descriptor belongs to this shell.
ownership_init() {
  ownership_holder_pid=$BASHPID
  ownership_sequence=0
  declare -gA ownership_fds=() ownership_anchors=() ownership_kinds=() ownership_paths=() ownership_seals=() ownership_children=() ownership_digests=() ownership_containers=() ownership_keys=()
}
ownership_key() { stat -c '%d:%i:%F' -- "$1"; }
# Trusted uid is this installer uid or root. POSIX ACL write grants are bounded by
# the group mask reflected in mode bits. Sticky shared parents protect owned entries.
ownership_boundary() {
  local parent="$1" uid permissions current_uid child_uid
  current_uid="$(id -u)"
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  read -r uid permissions < <(stat -c '%u %a' -- "$parent") || return 1
  [ "$uid" = "$current_uid" ] && (( (8#$permissions & 0022) == 0 )) || return 1
  child_uid="$uid"
  while [ "$parent" != / ]; do
    parent="$(dirname "$parent")"
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    read -r uid permissions < <(stat -c '%u %a' -- "$parent") || return 1
    [ "$uid" = 0 ] || [ "$uid" = "$current_uid" ] || return 1
    if (( (8#$permissions & 0022) != 0 )); then
      (( (8#$permissions & 01000) != 0 )) && { [ "$child_uid" = 0 ] || [ "$child_uid" = "$current_uid" ]; } || return 1
    fi
    child_uid="$uid"
  done
}

ownership_acquire() {
  local result_name="$1" path="$2" kind="$3" parent="${4:-$(dirname "$2")}" pin_fd new_token anchor='' before after
  [ "$BASHPID" = "$ownership_holder_pid" ] || { printf 'Ownership acquisition requires the owning shell\n' >&2; return 1; }
  ownership_boundary "$parent" && [ "$(dirname "$path")" = "$parent" ] || {
    printf 'Refusing ownership acquisition outside protected parent: %s\n' "$path" >&2; return 1;
  }
  matches_owned_kind "$path" "$kind" || { printf 'Refusing ownership acquisition of unexpected kind: %s\n' "$path" >&2; return 1; }
  before="$(ownership_key "$path")" || return 1
  case "$kind" in
    file|directory)
      exec {pin_fd}<"$path" || return 1
      after="$(stat -Lc '%d:%i:%F' -- "/proc/$ownership_holder_pid/fd/$pin_fd")" || { exec {pin_fd}<&-; return 1; }
      [ "$after" = "$before" ] && [ "$(ownership_key "$path")" = "$after" ] || { exec {pin_fd}<&-; return 1; }
      ;;
    link)
      anchor="$(umask 077 && mktemp -d "${ownership_anchor_parent:-$parent}/.ownership.XXXXXX")" || return 1
      if ! ln -P -T -- "$path" "$anchor/object" || [ "$(ownership_key "$anchor/object")" != "$before" ]; then
        [ ! -L "$anchor/object" ] || rm -- "$anchor/object"
        rmdir -- "$anchor" || true
        printf 'Refusing ownership acquisition without symlink anchor: %s\n' "$path" >&2; return 1
      fi
      ;;
    *) return 1 ;;
  esac
  ownership_sequence=$((ownership_sequence + 1)); new_token="own-$ownership_sequence"
  ownership_kinds[$new_token]="$kind"; ownership_paths[$new_token]="$path"; ownership_keys[$new_token]="$before"
  if [ "$kind" = file ]; then
    local digest; digest="$(sha256sum -- "/proc/$ownership_holder_pid/fd/$pin_fd")" || { exec {pin_fd}<&-; unset 'ownership_kinds[$new_token]' 'ownership_paths[$new_token]' 'ownership_keys[$new_token]'; return 1; }
    ownership_digests[$new_token]="${digest%% *}"
  fi
  if [ -n "$anchor" ]; then ownership_anchors[$new_token]="$anchor"; else ownership_fds[$new_token]="$pin_fd"; fi
  printf -v "$result_name" '%s' "$new_token"
}
ownership_matches() {
  local path="$1" token="$2" kind="$3" held
  [ -n "$token" ] || return 1
  [ -n "$kind" ] && [ "${ownership_kinds[$token]:-}" = "$kind" ] && matches_owned_kind "$path" "$kind" || return 1
  if [ "$kind" = link ]; then
    [ -L "${ownership_anchors[$token]:-}/object" ] || return 1
    held="$(ownership_key "${ownership_anchors[$token]}/object")" || return 1
  else
    [ -n "${ownership_fds[$token]:-}" ] || return 1
    held="$(stat -Lc '%d:%i:%F' -- "/proc/$ownership_holder_pid/fd/${ownership_fds[$token]}")" || return 1
  fi
  [ "$held" = "${ownership_keys[$token]:-}" ] && [ "$(ownership_key "$path")" = "$held" ]
}
ownership_transfer() {
  [ -n "$1" ] || return 1
  ownership_matches "$2" "$1" "${ownership_kinds[$1]:-}" || return 1
  ownership_paths[$1]="$2"
}
# Recursive disposal relies on this explicit protected subtree boundary, not on
# top-directory inode ownership. The trusted build writer has exited before seal.
# Privileged concurrent writers are outside this boundary; changes still refuse.
ownership_inventory() (
  set -o pipefail
  local path="$1" unsafe current_uid
  current_uid="$(id -u)"
  ownership_boundary "$path" || return 1
  cd -- "$path" || return 1
  unsafe="$(find . \( -type d -o -type f \) \( ! -uid "$current_uid" -o -perm /022 \) -print -quit)" || return 1
  [ -z "$unsafe" ] || { printf 'Refusing unprotected subtree entry: %s\n' "$unsafe" >&2; return 1; }
  unsafe="$(find . ! -type d ! -type f ! -type l -print -quit)" || return 1
  [ -z "$unsafe" ] || return 1
  # NUL records preserve arbitrary filenames and link targets. find and hashing
  # failures propagate through pipefail; no partial inventory becomes a seal.
  find . -mindepth 1 -printf '%P\t%D:%i:%y:%s:%U:%m:%T@:%l\0' | sort -z || return 1
  find . -type f -exec sha256sum -z -- {} + | sort -z || return 1
)
ownership_seal() {
  local token="$1" path="$2" inventory_digest
  ownership_matches "$path" "$token" directory || return 1
  inventory_digest="$(set -o pipefail; ownership_inventory "$path" | sha256sum)" || return 1
  ownership_seals[$token]="${inventory_digest%% *}"
}
ownership_verify_seal() {
  local token="$1" path="$2" inventory_digest
  [ -n "${ownership_seals[$token]:-}" ] || return 1
  inventory_digest="$(set -o pipefail; ownership_inventory "$path" | sha256sum)" || return 1
  [ "${inventory_digest%% *}" = "${ownership_seals[$token]}" ]
}

ownership_drop() {
  local token="$1" pin_fd anchor child
  [ -n "$token" ] || return 1
  # Children inherit descriptors, but only the owning shell disposes shared anchors.
  [ "$BASHPID" = "$ownership_holder_pid" ] || return 0
  for child in ${ownership_children[$token]:-}; do ownership_drop "$child" || return; done
  if [ -n "${ownership_fds[$token]:-}" ]; then pin_fd="${ownership_fds[$token]}"; exec {pin_fd}<&-; fi
  if [ -n "${ownership_anchors[$token]:-}" ]; then
    anchor="${ownership_anchors[$token]}"
    [ ! -L "$anchor/object" ] || rm -- "$anchor/object"
    rmdir -- "$anchor" || return 1
  fi
  if [ -n "${ownership_containers[$token]:-}" ]; then rmdir -- "${ownership_containers[$token]}" || return 1; fi
  unset 'ownership_fds[$token]' 'ownership_anchors[$token]' 'ownership_kinds[$token]' 'ownership_paths[$token]' 'ownership_seals[$token]' 'ownership_children[$token]' 'ownership_digests[$token]' 'ownership_containers[$token]' 'ownership_keys[$token]'
}
ownership_release_all() {
  local token failed=0
  for token in "${!ownership_kinds[@]}"; do ownership_drop "$token" || failed=1; done
  return "$failed"
}

ownership_unchanged() {
  local token="$1" path="$2" kind="$3" digest
  ownership_matches "$path" "$token" "$kind" || return 1
  if [ "$kind" = directory ]; then ownership_verify_seal "$token" "$path"; return $?; fi
  if [ "$kind" = file ]; then
    digest="$(sha256sum -- "$path")" || return 1
    [ "${digest%% *}" = "${ownership_digests[$token]:-}" ] || return 1
  fi
}
# Commands that may persist (npm, probes and service control) must not inherit pins.
ownership_without_references() (
  local token descriptor
  for token in "${!ownership_fds[@]}"; do descriptor="${ownership_fds[$token]}"; exec {descriptor}<&-; done
  "$@"
)

# Publication may remove recorded children; it may never adopt newly injected ones.
ownership_expect_empty() {
  local token="$1" path="$2" listing
  ownership_matches "$path" "$token" directory || return 1
  listing="$(find "$path" -mindepth 1 -print -quit)" || return 1
  [ -z "$listing" ] || return 1
  # All known published children are gone. This seal is the constant empty
  # inventory, not fresh adoption of entries from the mutable staging path.
  local empty_digest; empty_digest="$(printf '' | sha256sum)"
  ownership_seals[$token]="${empty_digest%% *}"
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
  [ -n "$expected_identity" ] || return 1
  ownership_matches "$path" "$expected_identity" "${ownership_kinds[$expected_identity]:-}"
}

# Destructive authorization is always against a retained reference, never metadata.
matches_detached_publication_identity() {
  [ -n "$2" ] || return 1
  ownership_matches "$1" "$2" "${ownership_kinds[$2]:-}"
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

# The quarantine parent is protected from unrelated writers, including the service
# user that may own the original parent. It must share the source filesystem. Once rename has
# detached the object, cleanup never traverses the attacker-visible original pathname.
quarantine_owned_path() {
  local path="$1" expected_identity="$2" kind="$3" label="$4" test_checkpoint="${5:-}"
  local parent base source_device quarantine_device
  owned_quarantine_path=''
  owned_quarantine_dir=''
  if ! { [ -e "$path" ] || [ -L "$path" ]; }; then
    return 2
  fi
  parent="$(dirname "$path")"
  while ! ownership_boundary "$parent"; do
    if [ "$parent" = / ]; then
      printf 'Refusing cleanup without a protected quarantine parent for %s: %s\n' "$label" "$path" >&2
      return 1
    fi
    parent="$(dirname "$parent")"
  done
  source_device="$(stat -c %d -- "$path")" || return 1
  quarantine_device="$(stat -c %d -- "$parent")" || return 1
  if [ "$source_device" != "$quarantine_device" ]; then
    printf 'Refusing cross-filesystem cleanup quarantine for %s: %s\n' "$label" "$path" >&2
    return 1
  fi
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
  if ! { matches_owned_kind "$owned_quarantine_path" "$kind" && ownership_unchanged "$expected_identity" "$owned_quarantine_path" "$kind"; }; then
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
  if ! { [ -n "$owned_quarantine_path" ] && matches_owned_kind "$owned_quarantine_path" "$kind" && ownership_unchanged "$expected_identity" "$owned_quarantine_path" "$kind"; }; then
    printf '%s\n' "Refusing to delete a substituted detached $label: ${owned_quarantine_path:-missing}" >&2
    return 1
  fi
  case "$kind" in
    directory)
      ownership_verify_seal "$expected_identity" "$owned_quarantine_path" || {
        printf 'Refusing to delete changed detached subtree: %s\n' "$owned_quarantine_path" >&2; return 1;
      }
      rm -rf -- "$owned_quarantine_path" ;;
    file|link) rm -- "$owned_quarantine_path" ;;
    *) die "Unknown owned path kind: $kind" ;;
  esac
  if { [ -e "$owned_quarantine_path" ] || [ -L "$owned_quarantine_path" ]; } || ! rmdir -- "$owned_quarantine_dir"; then
    printf '%s\n' "Refusing to leave an unverified cleanup quarantine for $label: $owned_quarantine_dir" >&2
    return 1
  fi
  ownership_drop "$expected_identity" || return 1
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


# Unpublished private staging never needs a public-path detach. Its protected
# boundary and retained pin remain held across verification and disposal.
ownership_discard_private() {
  local token="$1" path="$2" kind="$3" protected
  if [ "$kind" = directory ]; then protected="$path"; else protected="$(dirname "$path")"; fi
  ownership_boundary "$protected" && [ "$(stat -c %a -- "$protected")" = 700 ] || return 1
  ownership_unchanged "$token" "$path" "$kind" || return 1
  if [ "$kind" = directory ]; then rm -rf -- "$path"; else rm -- "$path"; fi
  [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
  ownership_drop "$token"
}
