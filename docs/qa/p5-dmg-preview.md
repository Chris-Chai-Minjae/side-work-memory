# Local DMG preview — 2026-09-27

## Scope

The user requested a DMG containing `Side.app` for GitHub distribution if possible. This report records the local package and the public binary release gate. It does not change the approved P5-T5.2 acceptance criteria.

## Local package verification

- Built `apps/side-mac/.build/release/Side.app` and packaged it with `apps/side-mac/scripts/package-dmg.sh` as `dist/Side-0.1.0-preview-macos-arm64.dmg` (111 MB).
- `codesign --verify --deep --strict` passed for the app before packaging and after mounting the DMG.
- `hdiutil verify` passed. The mounted DMG contains `Side.app` and an `Applications` shortcut. The bundled `side-resume` skill matched the source file.
- SHA-256: `011f888100cc8a58a7a01cc89e0e5ba1d1e5b78d7f0e6988011ad215e2cdfc1e`.
- The package script passed `sh -n`.

These checks prove local package integrity. They do not prove that the binary is ready for public redistribution or that it will run on a clean Mac.

## Public upload decision: NO-GO

- The app bundle contains a compiled Bun runtime, native libraries, web dependencies, and a converted MiniLM model, but no bundled `LICENSE`, `NOTICE`, or `COPYING` files for those components. See `docs/qa/p5-source-release.md`.
- Bun 1.3.5's license identifies statically linked JavaScriptCore/WebKit LGPL components. A verified path for users to rebuild or relink the app with modified library code has not been supplied.
- The bundled Xenova model files match revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`. The source model declares Apache-2.0, but the converted repository does not declare its own license metadata. The application of the source license and required notices to the bundled conversion still need to be documented.
- The app uses an ad hoc signature (`TeamIdentifier=not set`). `spctl -a -vv` returned `rejected`; the approved P5-T5.2 notarization gate is not met. An ad hoc signature alone does not prohibit distribution, but it is a separate install and release limitation.

The DMG remains a local artifact. No GitHub Release or binary asset was uploaded. The repository continues to offer the source build route.

## Next release gate

Inventory the actual bundled dependencies and include their required license/notice texts; pin and document the model license and revision; provide and verify the Bun/WebKit rebuild or relink path. Then build a new DMG and complete the approved Developer ID/notarization checks before a public binary release.
