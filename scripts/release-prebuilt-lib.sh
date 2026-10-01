#!/usr/bin/env bash
# Safe extraction boundary for an operator-built, root-sealed release archive.

stage_prebuilt_release() {
  local entry resolved
  require_absolute_path "$prebuilt_release_archive" PREBUILT_RELEASE_ARCHIVE
  require_regular_file "$prebuilt_release_archive" "prebuilt release archive"
  if ! is_simulated; then
    [ "$(stat -c '%u' -- "$prebuilt_release_archive")" = 0 ] || die "Prebuilt release archive must be root-owned"
  fi
  /usr/bin/tar --extract --file="$prebuilt_release_archive" \
    --directory="$candidate_staging_fs" --no-same-owner --no-same-permissions --keep-directory-symlink
  while IFS= read -r -d '' entry; do
    case "$(basename "$entry")" in dist|node_modules|package.json|package-lock.json|bin) ;; *) die "Prebuilt release contains an unexpected top-level entry" ;; esac
  done < <(find "$candidate_staging_fs" -mindepth 1 -maxdepth 1 -print0)
  while IFS= read -r -d '' entry; do
    resolved="$(readlink -f -- "$entry")" || die "Prebuilt release contains a broken symlink"
    path_is_within "$resolved" "$candidate_staging_fs" || die "Prebuilt release symlink escapes staging"
  done < <(find "$candidate_staging_fs" -type l -print0)
  [ -d "$candidate_staging_fs/dist" ] && [ ! -L "$candidate_staging_fs/dist" ] || die "Prebuilt release is missing dist"
  [ -d "$candidate_staging_fs/node_modules" ] && [ ! -L "$candidate_staging_fs/node_modules" ] || die "Prebuilt release is missing node_modules"
  require_regular_file "$candidate_staging_fs/package.json" "prebuilt package.json"
  require_regular_file "$candidate_staging_fs/package-lock.json" "prebuilt package-lock.json"
  require_regular_file "$candidate_staging_fs/bin/node" "prebuilt Node runtime"
  chmod 0755 "$candidate_staging_fs/bin/node"
  chown_root "$candidate_staging_fs"
  ownership_seal "$candidate_staging_identity" "$candidate_staging_fs" || die "Could not seal prebuilt subtree"
}
