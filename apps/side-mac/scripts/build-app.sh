#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$package_dir/../.." && pwd)

(cd "$repo_dir" && bun run scripts/gates/sync-version.ts)
swift build --package-path "$package_dir" -c release
bin_dir=$(swift build --package-path "$package_dir" -c release --show-bin-path)

app_dir="$package_dir/.build/release/Side.app"
resources="$app_dir/Contents/Resources"
rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS" "$resources/lib" "$resources/web" "$resources/models" "$resources/metadata"
cp "$bin_dir/Side" "$app_dir/Contents/MacOS/Side"
resource_bundle=
for candidate in "$bin_dir"/*.bundle; do
  [ -s "$candidate/Contents/Resources/hard-blocked-bundle-ids.json" ] || continue
  if [ -n "$resource_bundle" ]; then
    printf '%s\n' 'Multiple hard-blocked bundle ID resources' >&2
    exit 1
  fi
  resource_bundle=$candidate
done
if [ -z "$resource_bundle" ]; then
  printf '%s\n' 'Missing hard-blocked bundle ID resource' >&2
  exit 1
fi
cp -R "$resource_bundle" "$resources/"
cp "$package_dir/Info.plist" "$app_dir/Contents/Info.plist"
cp "$package_dir/Assets/AppIcon.icns" "$resources/AppIcon.icns"
cp "$package_dir/Assets/MenuBarTemplate.png" "$resources/MenuBarTemplate.png"
cp "$package_dir/Assets/MenuBarTemplate@2x.png" "$resources/MenuBarTemplate@2x.png"
mkdir -p "$resources/skills/side-resume"
cp "$repo_dir/skills/side-resume/SKILL.md" "$resources/skills/side-resume/SKILL.md"
(cd "$repo_dir" && bun run scripts/build-daemon.ts src/cli.ts "$resources/side")

sqlite_library=${SIDE_SQLITE_LIBRARY:-}
if [ -z "$sqlite_library" ]; then
  for candidate in /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib /usr/local/opt/sqlite/lib/libsqlite3.dylib; do
    if [ -f "$candidate" ]; then sqlite_library=$candidate; break; fi
  done
fi
if [ ! -f "$sqlite_library" ]; then
  printf '%s\n' 'Missing build-time SQLite dylib with FTS5 and extension loading' >&2
  exit 1
fi
(cd "$repo_dir" && bun run scripts/gates/verify-sqlite.ts "$sqlite_library")
cp -L "$sqlite_library" "$resources/lib/libsqlite3.dylib"
install_name_tool -id @rpath/libsqlite3.dylib "$resources/lib/libsqlite3.dylib"
codesign --force --sign - "$resources/lib/libsqlite3.dylib"
vec_library=$(cd "$repo_dir" && bun -e 'import { getLoadablePath } from "sqlite-vec"; console.log(getLoadablePath())')
cp "$vec_library" "$resources/lib/vec0.dylib"
native_arch=$(bun -e 'console.log(process.arch)')
cp "$repo_dir/node_modules/onnxruntime-node/bin/napi-v6/darwin/$native_arch/libonnxruntime.1.dylib" "$resources/lib/"

(cd "$repo_dir" && bun run build:web)
cp -R "$repo_dir/src/web/dist/." "$resources/web/"
model_rel=Xenova/paraphrase-multilingual-MiniLM-L12-v2
model_dir="$resources/models/$model_rel"
if [ -n "${SIDE_MODEL_CACHE_SOURCE:-}" ]; then
  mkdir -p "$model_dir/onnx"
  for asset in config.json tokenizer_config.json tokenizer.json onnx/model_quantized.onnx; do
    cp "$SIDE_MODEL_CACHE_SOURCE/$model_rel/$asset" "$model_dir/$asset"
  done
else
  (cd "$repo_dir" && bun run scripts/prefetch-model.ts "$resources/models")
fi
for asset in "$model_dir/config.json" "$model_dir/tokenizer_config.json" "$model_dir/tokenizer.json" "$model_dir/onnx/model_quantized.onnx"; do
  if [ ! -s "$asset" ]; then
    printf 'Missing bundled model asset: %s\n' "$asset" >&2
    exit 1
  fi
done
(cd "$repo_dir" && bun run scripts/gates/verify-model.ts "$resources/models")
(cd "$repo_dir" && SIDE_SQLITE_SOURCE="$sqlite_library" bun run scripts/gates/release-metadata.ts "$app_dir")

codesign --force --sign - "$resources/lib/vec0.dylib"
codesign --force --sign - "$resources/lib/libonnxruntime.1.dylib"
codesign --force --sign - "$resources/side"
(cd "$repo_dir" && bun run scripts/gates/build-manifest.ts "$app_dir")
codesign --force --sign - "$app_dir"
codesign --verify --deep --strict "$app_dir"
"$resources/side" help >/dev/null

printf '%s\n' "$app_dir"
