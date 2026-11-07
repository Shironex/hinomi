#!/usr/bin/env bash
# Lints the workflows, the fix toolchain action and the caller template with pinned
# actionlint and zizmor.
# Each tool is downloaded once into a cache folder and checked against its SHA-256 before it
# runs. Works on Linux and macOS (x64 and arm64); on Windows run it from Git Bash or WSL.
#
#   .github/scripts/lint-workflows.sh
set -euo pipefail

ACTIONLINT_VERSION=1.7.12
ZIZMOR_VERSION=1.31.1

root=$(cd "$(dirname "$0")/../.." && pwd)
cache=${HINOMI_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/hinomi-tools}
mkdir -p "$cache"

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Linux/x86_64)
    actionlint_asset=linux_amd64
    actionlint_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    zizmor_asset=x86_64-unknown-linux-gnu
    zizmor_sha=d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99
    ;;
  Linux/aarch64 | Linux/arm64)
    actionlint_asset=linux_arm64
    actionlint_sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
    zizmor_asset=aarch64-unknown-linux-gnu
    zizmor_sha=37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833
    ;;
  Darwin/arm64)
    actionlint_asset=darwin_arm64
    actionlint_sha=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
    zizmor_asset=aarch64-apple-darwin
    zizmor_sha=ad5aa633cd56215b11e6c51d51f90c7e6b22904a75047d1215abbd422f61d698
    ;;
  Darwin/x86_64)
    actionlint_asset=darwin_amd64
    actionlint_sha=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644
    zizmor_asset=x86_64-apple-darwin
    zizmor_sha=72ae63bb85b67229c06242f04195cb43927e9fab5f43803c6434dc701a517d61
    ;;
  *)
    echo "lint-workflows: no pinned tools for $os/$arch" >&2
    exit 1
    ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch <name> <url> <sha256> <binary inside the archive>
fetch() {
  local dir="$cache/$1" archive
  if [ ! -x "$dir/$4" ]; then
    archive=$(mktemp)
    curl -fsSL --retry 3 -o "$archive" "$2"
    if [ "$(sha256 "$archive")" != "$3" ]; then
      echo "lint-workflows: checksum mismatch for $2" >&2
      rm -f "$archive"
      exit 1
    fi
    mkdir -p "$dir"
    tar -xzf "$archive" -C "$dir"
    rm -f "$archive"
  fi
  echo "$dir/$4"
}

actionlint=$(fetch "actionlint-$ACTIONLINT_VERSION" \
  "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION}_${actionlint_asset}.tar.gz" \
  "$actionlint_sha" actionlint)
zizmor=$(fetch "zizmor-$ZIZMOR_VERSION" \
  "https://github.com/zizmorcore/zizmor/releases/download/v$ZIZMOR_VERSION/zizmor-${zizmor_asset}.tar.gz" \
  "$zizmor_sha" zizmor)

cd "$root"

# The caller template carries a SHA placeholder; lint a copy pinned to a dummy commit.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.github/workflows"
sed 's/<40 char sha>/0000000000000000000000000000000000000000/' docs/runner/hinomi-fix.yml \
  > "$scratch/.github/workflows/hinomi-fix.yml"

echo "actionlint $ACTIONLINT_VERSION"
"$actionlint" -config-file .github/actionlint.yaml
"$actionlint" -config-file .github/actionlint.yaml "$scratch/.github/workflows/hinomi-fix.yml"

echo "zizmor $ZIZMOR_VERSION"
"$zizmor" --offline --config .github/zizmor.yml .github/workflows actions/fix-toolchain/action.yml \
  "$scratch/.github/workflows/hinomi-fix.yml"
