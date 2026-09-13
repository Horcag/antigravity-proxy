#!/bin/bash
set -euo pipefail

[ "$#" -eq 0 ] || { printf '%s\n' 'Autonomous updater accepts no arguments' >&2; exit 1; }
[ "${EUID:-$(id -u)}" -eq 0 ] || { printf '%s\n' 'Autonomous updater must run as root' >&2; exit 1; }

config_file=/etc/antigravity-proxy/updater.conf
[ -f "$config_file" ] && [ ! -L "$config_file" ] || { printf '%s\n' 'Missing trusted updater configuration' >&2; exit 1; }
[ "$(stat -c '%u' -- "$config_file")" = 0 ] || { printf '%s\n' 'Updater configuration must be root-owned' >&2; exit 1; }
config_mode=$((8#$(stat -c '%a' -- "$config_file")))
(( (config_mode & 0022) == 0 )) || { printf '%s\n' 'Updater configuration must not be writable by group or others' >&2; exit 1; }
# shellcheck source=/dev/null
source "$config_file"

case "${PROJECT_DIR:-}" in /*) ;; *) printf '%s\n' 'Invalid PROJECT_DIR' >&2; exit 1 ;; esac
case "${RELEASE_OPERATOR:-}" in ''|root|*[!A-Za-z0-9._-]*) printf '%s\n' 'Invalid RELEASE_OPERATOR' >&2; exit 1 ;; esac
project_dir="$(readlink -f -- "$PROJECT_DIR")"
[ -d "$project_dir/.git" ] || { printf '%s\n' 'Configured project is not a Git checkout' >&2; exit 1; }
operator_home="$(getent passwd "$RELEASE_OPERATOR" | cut -d: -f6)"
case "$operator_home" in /*) ;; *) printf '%s\n' 'Invalid release operator home' >&2; exit 1 ;; esac

runtime_bin="$operator_home/.local/share/fnm/aliases/default/bin"
node_binary="$(readlink -f -- "$runtime_bin/node")"
npm_binary="$(readlink -f -- "$runtime_bin/npm")"
for binary in "$node_binary" "$npm_binary"; do
  [ -f "$binary" ] && [ -x "$binary" ] && [ ! -L "$binary" ] || { printf 'Invalid operator runtime: %s\n' "$binary" >&2; exit 1; }
  [ "$(stat -c '%u' -- "$binary")" = "$(id -u "$RELEASE_OPERATOR")" ] || { printf 'Unexpected runtime owner: %s\n' "$binary" >&2; exit 1; }
done

commit="$(runuser -u "$RELEASE_OPERATOR" -- git -C "$project_dir" rev-parse --verify HEAD)"
case "$commit" in [0-9a-f][0-9a-f]*) ;; *) printf '%s\n' 'Unable to resolve committed release SHA' >&2; exit 1 ;; esac
source_stage="$(mktemp -d /var/tmp/antigravity-proxy-source.XXXXXXXX)"
source_archive="$(mktemp /var/tmp/antigravity-proxy-source-archive.XXXXXXXX.tar)"
sealed_archive="$(mktemp /var/tmp/antigravity-proxy-sealed-release.XXXXXXXX.tar)"
cleanup() {
  case "$source_stage" in /var/tmp/antigravity-proxy-source.*) rm -rf -- "$source_stage" ;; esac
  case "$source_archive" in /var/tmp/antigravity-proxy-source-archive.*.tar) rm -f -- "$source_archive" ;; esac
  case "$sealed_archive" in /var/tmp/antigravity-proxy-sealed-release.*.tar) rm -f -- "$sealed_archive" ;; esac
}
trap cleanup EXIT
chown "$RELEASE_OPERATOR:$(id -gn "$RELEASE_OPERATOR")" "$source_stage"
chown "$RELEASE_OPERATOR:$(id -gn "$RELEASE_OPERATOR")" "$source_archive"
runuser -u "$RELEASE_OPERATOR" -- git -C "$project_dir" archive --format=tar --output="$source_archive" "$commit"
runuser -u "$RELEASE_OPERATOR" -- tar -xf "$source_archive" -C "$source_stage"
rm -f -- "$source_archive"

runuser -u "$RELEASE_OPERATOR" -- env \
  -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  HOME="$operator_home" PATH="$runtime_bin:/usr/local/bin:/usr/bin:/bin" \
  "$npm_binary" ci --prefix "$source_stage"
runuser -u "$RELEASE_OPERATOR" -- env \
  -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  HOME="$operator_home" PATH="$runtime_bin:/usr/local/bin:/usr/bin:/bin" \
  "$npm_binary" run --prefix "$source_stage" build
runuser -u "$RELEASE_OPERATOR" -- env \
  -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  HOME="$operator_home" PATH="$runtime_bin:/usr/local/bin:/usr/bin:/bin" \
  "$npm_binary" prune --prefix "$source_stage" --omit=dev

[ -d "$source_stage/dist" ] && [ ! -L "$source_stage/dist" ] || { printf '%s\n' 'Build did not produce a safe dist directory' >&2; exit 1; }
[ -f "$source_stage/package.json" ] && [ ! -L "$source_stage/package.json" ] || { printf '%s\n' 'Unsafe package.json' >&2; exit 1; }
[ -f "$source_stage/package-lock.json" ] && [ ! -L "$source_stage/package-lock.json" ] || { printf '%s\n' 'Unsafe package-lock.json' >&2; exit 1; }
if find "$source_stage/dist" -type l -print -quit | grep -q .; then
  printf '%s\n' 'Release build contains symlinks' >&2
  exit 1
fi
/usr/sbin/runuser -u "$RELEASE_OPERATOR" -- /usr/bin/install -d -m 0755 "$source_stage/bin"
runuser -u "$RELEASE_OPERATOR" -- install -m 0755 "$node_binary" "$source_stage/bin/node"
/usr/sbin/runuser -u "$RELEASE_OPERATOR" -- /usr/bin/env \
  -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  /usr/bin/tar -C "$source_stage" -cf - dist node_modules package.json package-lock.json bin/node >"$sealed_archive"
chown root:"$(id -gn "$RELEASE_OPERATOR")" "$sealed_archive"
chmod 0640 "$sealed_archive"

release_id="$(date -u +%Y%m%d%H%M%S)-${commit:0:8}"
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  PROJECT_DIR="$source_stage" RELEASE_OPERATOR="$RELEASE_OPERATOR" RELEASE_ID="$release_id" \
  PREBUILT_RELEASE_ARCHIVE="$sealed_archive" SKIP_IMPORT_HELPER=1 REQUIRE_EXISTING_ENV=1 \
  /usr/local/libexec/antigravity-proxy-updater/install-systemd.sh update
