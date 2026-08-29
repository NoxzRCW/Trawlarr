# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- A first test suite (pytest) covering health degradation, the TMDB Discover
  allowlist, cursor clamping and auto-list persistence, run by CI and blocking
  the image build on failure.
- Backend logging, and a startup check that reports an unwritable data
  directory in the logs and in `/api/health` instead of failing later with an
  opaque 500.
- `CONTRIBUTING.md`, `SECURITY.md`, a bug report template, and this changelog.
- Keyboard and screen-reader support for the dialogs: `role="dialog"`, focus
  trapping, focus returned where it came from, a visible focus ring, a skip
  link, and card actions that appear on focus as well as on hover.

### Changed
- Inter is served from the container instead of Google Fonts, so the page makes
  no third-party request.
- Auto-lists persist to a named Docker volume, so `docker compose up` works
  with no host permission setup.
- The container runs as a non-root user, drops all capabilities and mounts its
  filesystem read-only; compose binds to `127.0.0.1`.
- GitHub Actions are pinned by commit SHA.
- Base image on Python 3.14; fastapi and pydantic updated.

### Fixed
- Radarr or Sonarr being unreachable turned every request into a 500 and marked
  the container unhealthy. Those are business errors now, and `/api/health`
  reports each service separately without ever failing.
- Editing a paused auto-list silently re-enabled it, a running scan could
  overwrite an edit made during its 12-hour window, and a show whose TVDB id
  TMDB had not published yet was cached as permanently unaddable.
- A corrupt `lists.json` was mistaken for "no lists" and overwritten on the next
  save. It is now preserved as evidence.
- Four places rendered data from Radarr, Sonarr or a saved list as HTML.
- Untrusted integers (cursors, page sizes, scan depth) are clamped.
- httpx logged every request URL at INFO, which printed the TMDB API key —
  passed by TMDB as a query parameter — into the container logs.

## [1.0.0] - 2026-08-28

First public release: every TMDB Discover filter in front of Radarr and Sonarr,
auto-lists that keep adding new releases on their own, an optional
natural-language assistant, and an English and French interface.

[Unreleased]: https://github.com/NoxzRCW/Trawlarr/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NoxzRCW/Trawlarr/releases/tag/v1.0.0
