#!/bin/sh
# Local evaluation package. Public distribution requires the binary release gate.
set -eu

if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Usage: package-dmg.sh Side.app output.dmg' >&2
  exit 1
fi

app=$1
output=$2
[ -d "$app/Contents" ] || { printf '%s\n' "Missing app bundle: $app" >&2; exit 1; }
[ ! -e "$output" ] || { printf '%s\n' "Output already exists: $output" >&2; exit 1; }
codesign --verify --deep --strict "$app"

stage=$(mktemp -d "${TMPDIR:-/tmp}/side-dmg.XXXXXX")
trap 'rm -rf "$stage"' 0
trap 'exit 1' 1 2 3 15
ditto "$app" "$stage/Side.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -srcfolder "$stage" -volname 'Side Work Memory' -format UDZO -imagekey zlib-level=9 "$output"
hdiutil verify -quiet "$output"
printf 'PASS DMG package: %s\n' "$output"
