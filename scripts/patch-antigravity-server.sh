#!/usr/bin/env bash
# Managed Antigravity Language Server (IDE) Patch Tool
set -euo pipefail

ACTION="${1:-status}"
SERVER_BASE="${2:-$HOME/.antigravity-server/bin}"
PROXY_URL="${AG_PROXY_URL:-http://127.0.0.1:8317}"
TRUST_BUNDLE="/usr/local/share/antigravity-proxy/agy-trust.pem"
if [ ! -r "$TRUST_BUNDLE" ] && [ -r "$HOME/.antigravity-proxy/certs/agy-trust.pem" ]; then
    TRUST_BUNDLE="$HOME/.antigravity-proxy/certs/agy-trust.pem"
fi

is_elf() {
    local file="$1"
    [ -f "$file" ] && [ "$(head -c 4 "$file" 2>/dev/null)" = $'\x7fELF' ]
}

case "$ACTION" in
    status)
        echo "=== Antigravity Language Server (IDE) Status ==="
        echo "Directory: $SERVER_BASE"
        echo "Proxy URL: $PROXY_URL"
        echo "Trust CA:  $TRUST_BUNDLE"
        echo "------------------------------------------------"
        if [ ! -d "$SERVER_BASE" ]; then
            echo "No Antigravity server installations found at $SERVER_BASE"
            exit 0
        fi

        for dir in "$SERVER_BASE"/*; do
            [ -d "$dir" ] || continue
            ver="$(basename "$dir")"
            server="$dir/language_server"
            server_bin="$dir/language_server.bin"

            if [ -f "$server" ] && [ -f "$server_bin" ] && ! is_elf "$server" && is_elf "$server_bin"; then
                echo "  [$ver] PATCHED (wrapper active -> language_server.bin)"
            elif [ -f "$server" ] && [ ! -f "$server_bin" ] && is_elf "$server"; then
                echo "  [$ver] UNPATCHED (native binary, no proxy)"
            elif [ -f "$server_bin" ] && [ ! -f "$server" ]; then
                echo "  [$ver] CORRUPT (binary exists but wrapper missing)"
            else
                echo "  [$ver] UNKNOWN STATE"
            fi
        done
        ;;

    patch)
        echo "Patching Antigravity language_server installations..."
        if [ ! -d "$SERVER_BASE" ]; then
            echo "Error: Directory $SERVER_BASE does not exist." >&2
            exit 1
        fi

        count=0
        for dir in "$SERVER_BASE"/*; do
            [ -d "$dir" ] || continue
            ver="$(basename "$dir")"
            server="$dir/language_server"
            server_bin="$dir/language_server.bin"

            if [ -f "$server" ] && is_elf "$server"; then
                mv "$server" "$server_bin"
            fi

            if [ -f "$server_bin" ]; then
                cat << 'EOF' > "$server.tmp.$$"
#!/bin/sh
# Managed Antigravity Language Server Launcher with Transparent HTTPS Proxy Failover

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_REAL="$SERVER_DIR/language_server.bin"
TRUST_BUNDLE="/usr/local/share/antigravity-proxy/agy-trust.pem"
if [ ! -r "$TRUST_BUNDLE" ] && [ -r "$HOME/.antigravity-proxy/certs/agy-trust.pem" ]; then
    TRUST_BUNDLE="$HOME/.antigravity-proxy/certs/agy-trust.pem"
fi
PROXY_URL="http://127.0.0.1:8317"

if [ ! -x "$SERVER_REAL" ]; then
    printf '%s\n' 'antigravity language_server: real binary is unavailable' >&2
    exit 126
fi

if [ -r "$TRUST_BUNDLE" ]; then
    export SSL_CERT_FILE="$TRUST_BUNDLE"
fi

export HTTPS_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL"
# Authentication belongs to the native account and must survive rotation proxy downtime.
export NO_PROXY="localhost,127.0.0.1,::1,www.googleapis.com,oauth2.googleapis.com,accounts.google.com,${NO_PROXY:-},${no_proxy:-}"
export no_proxy="$NO_PROXY"

exec "$SERVER_REAL" "$@"
EOF
                chmod +x "$server.tmp.$$"
                mv "$server.tmp.$$" "$server"
                echo "  [$ver] Successfully patched."
                count=$((count + 1))
            fi
        done
        echo "Done. Patched $count version(s)."
        ;;

    unpatch)
        echo "Restoring native Antigravity language_server binaries..."
        if [ ! -d "$SERVER_BASE" ]; then
            echo "Error: Directory $SERVER_BASE does not exist." >&2
            exit 1
        fi

        count=0
        for dir in "$SERVER_BASE"/*; do
            [ -d "$dir" ] || continue
            ver="$(basename "$dir")"
            server="$dir/language_server"
            server_bin="$dir/language_server.bin"

            if [ -f "$server_bin" ]; then
                if [ -f "$server" ] && ! is_elf "$server"; then
                    rm -f "$server"
                fi
                if [ ! -f "$server" ]; then
                    mv "$server_bin" "$server"
                    echo "  [$ver] Restored native binary."
                    count=$((count + 1))
                fi
            fi
        done
        echo "Done. Restored $count version(s)."
        ;;

    *)
        echo "Usage: $0 {status|patch|unpatch} [server_base_dir]" >&2
        exit 1
        ;;
esac
