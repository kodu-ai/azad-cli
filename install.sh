#!/bin/sh
# Installs the azad CLI from its GitHub Releases (https://github.com/kodu-ai/azad-cli).
#
#   curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
#
# Environment:
#   AZAD_VERSION      install this release (for example 0.0.1) instead of the latest
#   AZAD_INSTALL_DIR  install into this directory instead of ~/.local/bin
#
# The executable is verified against the release's SHA256SUMS before it is
# moved into place; a failed download or checksum installs nothing.
set -eu

repository="kodu-ai/azad-cli"
releases="https://github.com/$repository/releases"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    fail "This script installs azad on Linux and macOS. On Windows, download azad-windows-x64.exe from $releases/latest and check it against SHA256SUMS there, or run this script in WSL."
    ;;
  *) fail "azad runs on Linux, macOS and Windows; this system is not one of them." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "azad has no build for the $(uname -m) CPU architecture." ;;
esac
# An x64 shell under Rosetta still gets the native Apple silicon build.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
  fail "azad's Linux builds need glibc; Alpine and other musl systems are not supported."
fi

command -v curl >/dev/null 2>&1 || fail "Install curl, then retry."
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
  fail "Install sha256sum or shasum, then retry."

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$@"
}

if [ -n "${AZAD_VERSION:-}" ]; then
  version=${AZAD_VERSION#v}
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
    fail "AZAD_VERSION must be a release version, such as 0.0.1."
else
  # Resolve "latest" once, so the checksums and the executable come from the same release.
  latest=$(fetch -o /dev/null -w '%{url_effective}' "$releases/latest") ||
    fail "Could not reach $releases. Check your connection, then retry."
  version=${latest##*/}
  version=${version#v}
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
    fail "No azad release is published yet at $releases."
fi

asset="azad-$os-$arch"
base="$releases/download/v$version"
install_dir="${AZAD_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
[ ! -d "$install_dir/azad" ] || fail "$install_dir/azad is a directory; nothing was installed."
# The scratch directory sits beside the target, so the final move is atomic.
scratch=$(mktemp -d "$install_dir/.azad-install.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' HUP INT TERM

fetch -o "$scratch/SHA256SUMS" "$base/SHA256SUMS" ||
  fail "Could not download $base/SHA256SUMS. Check AZAD_VERSION and your connection."
expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$scratch/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "azad $version has no $asset build."
fetch -o "$scratch/azad" "$base/$asset" || fail "Could not download $base/$asset."
actual=$(sha256 "$scratch/azad")
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail "The download of $asset does not match its SHA-256 checksum. Nothing was installed."
chmod 755 "$scratch/azad"
mv -f "$scratch/azad" "$install_dir/azad"

echo "Installed azad $version at $install_dir/azad"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH, or run $install_dir/azad directly." ;;
esac
echo "Run azad to set up a self-hosted Azad, or azad --help for every command."
