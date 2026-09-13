#!/usr/bin/env bash
set -euo pipefail

[ "${EUID:-$(id -u)}" -eq 0 ] || { printf '%s\n' 'Run once with sudo' >&2; exit 1; }
[ "$#" -eq 0 ] || { printf '%s\n' 'This installer accepts no arguments' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
release_operator="${SUDO_USER:-}"
case "$release_operator" in ''|root|*[!A-Za-z0-9._-]*) printf '%s\n' 'A non-root SUDO_USER is required' >&2; exit 1 ;; esac

libexec_dir=/usr/local/libexec/antigravity-proxy-updater
config_dir=/etc/antigravity-proxy
sudoers_file=/etc/sudoers.d/antigravity-proxy-update
install -d -o root -g root -m 0755 "$libexec_dir" "$config_dir"
install -o root -g root -m 0755 "$script_dir/autonomous-update-root.sh" "$libexec_dir/update"
install -o root -g root -m 0755 "$script_dir/install-systemd.sh" "$libexec_dir/install-systemd.sh"
install -o root -g root -m 0644 "$script_dir/release-lib.sh" "$libexec_dir/release-lib.sh"
install -o root -g root -m 0644 "$script_dir/release-runtime-lib.sh" "$libexec_dir/release-runtime-lib.sh"
install -o root -g root -m 0644 "$script_dir/release-prebuilt-lib.sh" "$libexec_dir/release-prebuilt-lib.sh"
install -o root -g root -m 0755 "$script_dir/import-accounts-stdin.sh" "$libexec_dir/import-accounts-stdin.sh"
printf 'PROJECT_DIR=%q\nRELEASE_OPERATOR=%q\n' "$project_dir" "$release_operator" >"$config_dir/updater.conf"
chown root:root "$config_dir/updater.conf"
chmod 0644 "$config_dir/updater.conf"
install -o root -g root -m 0755 "$script_dir/autonomous-update-launcher.sh" /usr/local/sbin/antigravity-proxy-update

temporary_sudoers="$(mktemp /etc/sudoers.d/.antigravity-proxy-update.XXXXXXXX)"
trap 'rm -f -- "$temporary_sudoers"' EXIT
printf '%s ALL=(root) NOPASSWD:NOSETENV: /usr/local/sbin/antigravity-proxy-update ""\n' "$release_operator" >"$temporary_sudoers"
chmod 0440 "$temporary_sudoers"
visudo -cf "$temporary_sudoers" >/dev/null
mv -f -- "$temporary_sudoers" "$sudoers_file"
trap - EXIT
printf 'Autonomous updater installed for %s\n' "$release_operator"
