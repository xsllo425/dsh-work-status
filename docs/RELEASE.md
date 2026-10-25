# Releasing

Pre-flight for a public GitHub release of `dsh-work-status`.

## 1. Verify

```bash
node --check lib/client.js && node --check lib/activity.js && node --check lib/index.js
node --test tests/*.test.mjs        # all green, no dependencies
node scripts/check-manifest.mjs     # manifest / exports / patch row / icon / locales
npm pack --dry-run                  # tarball contains lib, locale, icon, docs of record
```

All three checks run in CI (`.github/workflows/ci.yml`, Node 24).

## 2. Version and notes

- `package.json` `version` and `CHANGELOG.md` entry carry the same number.
- `CHANGELOG.md` — newest first, concrete changes, no placeholders.
- `stateVersion` in `lib/activity.js` is bumped whenever the projection state shape changes; stale checkpoints must rebuild from the log.

## 3. Fresh-machine check (recommended for a release)

1. Install from the packed tarball (`npm pack`, then Plugin Manager `install file:./dsh-work-status-<version>.tgz`).
2. Restart the app; the row appears above the composer.
3. Exercise the card: collapsed line, open, row expansion, log, copy, fold.
4. Uninstall → the row disappears; nothing else changes.

## 4. Repository metadata

- `package.json`: `author`, `repository`, `homepage`, `bugs`, `keywords`, `license: MIT`.
- `LICENSE` (MIT) and `NOTICE` (derivation from `dsh-agent-activity` 0.9.0) are committed.
- README shows current version references as `<version>` placeholders, screenshots in `docs/screenshots/`.
- GitHub topics to set: `dsh-plugin`, `deepseek-harness`, `dsh`, `plugin`.

## 5. Publish

Public steps are manual: the first `git push`, the GitHub repository creation, and the release notes.

- Tag: `git tag v<version> && git push origin v<version>`.
- Release notes: paste the `CHANGELOG.md` section for that version.
- The npm registry is not used; installation is GitHub / local / tarball.
