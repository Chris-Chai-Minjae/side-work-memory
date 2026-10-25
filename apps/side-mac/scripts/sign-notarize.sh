#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$package_dir/../.." && pwd)
entitlements="$package_dir/Side.entitlements"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

required_string() {
  value=$(plutil -extract "$1" raw -o - "$2") || fail "Missing Info.plist key: $1"
  [ -n "$value" ] || fail "Empty Info.plist key: $1"
}

preflight() {
  app=$1
  [ -d "$app/Contents" ] || fail "Missing app bundle: $app"
  for item in \
    Contents/MacOS/Side \
    Contents/Resources/side \
    Contents/Resources/lib/libsqlite3.dylib \
    Contents/Resources/lib/vec0.dylib \
    Contents/Resources/lib/libonnxruntime.1.dylib \
    Contents/Resources/metadata/THIRD_PARTY_NOTICES.txt \
    Contents/Resources/metadata/sbom.json \
    Contents/Resources/metadata/model-provenance.json \
    Contents/Resources/metadata/build-manifest.json; do
    [ -s "$app/$item" ] || fail "Missing bundle release asset: $item"
  done
  plutil -lint "$app/Contents/Info.plist" "$entitlements" >/dev/null || fail "Invalid release plist"
  required_string CFBundleShortVersionString "$app/Contents/Info.plist"
  required_string CFBundleVersion "$app/Contents/Info.plist"
  required_string NSAppleEventsUsageDescription "$app/Contents/Info.plist"
  required_string NSScreenCaptureUsageDescription "$app/Contents/Info.plist"
  enabled=$(plutil -extract 'com\.apple\.security\.automation\.apple-events' raw -o - "$entitlements") || fail "Missing Apple Events entitlement"
  [ "$enabled" = true ] || fail "Apple Events entitlement is disabled"
  printf '%s\n' "PASS release preflight: $app"
}

redistribution() {
  (cd "$repo_dir" && bun run scripts/gates/verify-redistribution.ts "$1")
}

case "${1:-}" in
  preflight)
    [ "$#" -eq 2 ] || fail "Usage: $0 preflight Side.app"
    preflight "$2"
    ;;
  redistribute)
    [ "$#" -eq 2 ] || fail "Usage: $0 redistribute Side.app"
    preflight "$2"
    redistribution "$2"
    ;;
  release)
    [ "$#" -eq 5 ] || fail "Usage: $0 release Side.app 'Developer ID Application: ...' keychain-profile output.zip"
    source_app=$2
    identity=$3
    profile=$4
    output_zip=$5
    preflight "$source_app"
    case "$identity" in
      "Developer ID Application: "*) ;;
      *) fail "A Developer ID Application identity is required" ;;
    esac
    [ -n "$profile" ] || fail "A notarytool keychain profile is required"
    [ ! -e "$output_zip" ] || fail "Output ZIP already exists: $output_zip"
    output_parent=$(dirname -- "$output_zip")
    [ -d "$output_parent" ] || fail "Output directory does not exist: $output_parent"
    security find-identity -v -p codesigning | grep -F "\"$identity\"" >/dev/null || fail "Developer ID identity is not installed: $identity"
    redistribution "$source_app"

    work_dir=$(mktemp -d "${TMPDIR:-/tmp}/side-notarize.XXXXXX")
    output_work_dir=$(mktemp -d "$output_parent/.side-release.XXXXXX")
    trap 'rm -rf "$work_dir" "$output_work_dir"' 0
    trap 'exit 1' 1 2 3 15
    app="$work_dir/Side.app"
    ditto "$source_app" "$app"
    resources="$app/Contents/Resources"

    for item in \
      "$resources/lib/libsqlite3.dylib" \
      "$resources/lib/vec0.dylib" \
      "$resources/lib/libonnxruntime.1.dylib" \
      "$resources/side"; do
      codesign --force --sign "$identity" --options runtime --timestamp "$item"
    done
    (cd "$repo_dir" && bun run scripts/gates/build-manifest.ts "$app")
    codesign --force --sign "$identity" --options runtime --timestamp --entitlements "$entitlements" "$app"
    codesign --verify --deep --strict --verbose=2 "$app"
    redistribution "$app"

    upload_zip="$work_dir/Side-upload.zip"
    ditto -c -k --keepParent "$app" "$upload_zip"
    if ! submission=$(xcrun notarytool submit "$upload_zip" --keychain-profile "$profile" --wait --output-format json); then
      fail "NOTARIZATION: ERROR submission command failed: $submission"
    fi
    status=$(printf '%s' "$submission" | plutil -extract status raw -o - -) || fail "Could not read notarization status"
    submission_id=$(printf '%s' "$submission" | plutil -extract id raw -o - -) || fail "Could not read notarization submission ID"
    printf 'NOTARIZATION: %s (%s)\n' "$status" "$submission_id"
    if [ "$status" != Accepted ]; then
      notary_log="$work_dir/notary-log.txt"
      if xcrun notarytool log "$submission_id" --keychain-profile "$profile" >"$notary_log" 2>&1; then
        printf '%s\n' '--- notarytool log (last 16 KiB) ---' >&2
        tail -c 16384 "$notary_log" >&2
      else
        printf '%s\n' 'Could not retrieve notarytool log:' >&2
        tail -c 4096 "$notary_log" >&2
      fi
      fail "NOTARIZATION: FAIL $status; redistribution artifact was not published"
    fi

    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    assessment=$(spctl -a -vv "$app" 2>&1) || fail "Gatekeeper rejected stapled app: $assessment"
    case "$assessment" in
      *accepted*"source=Notarized Developer ID"*) ;;
      *) fail "Gatekeeper did not report Notarized Developer ID: $assessment" ;;
    esac
    ditto -c -k --keepParent "$app" "$output_work_dir/Side.zip"
    [ ! -e "$output_zip" ] || fail "Output ZIP appeared during release: $output_zip"
    mv "$output_work_dir/Side.zip" "$output_zip"
    printf 'NOTARIZATION: PASS; REDISTRIBUTION: PASS signed release: %s\n' "$output_zip"
    ;;
  *) fail "Usage: $0 preflight Side.app | redistribute Side.app | release Side.app identity keychain-profile output.zip" ;;
esac
