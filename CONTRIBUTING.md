# Contributing

Thanks for looking. Trawlarr is small on purpose, and the fastest way to get a
change merged is to keep it small too.

## Running it locally

```bash
git clone https://github.com/NoxzRCW/Trawlarr.git
cd Trawlarr
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env      # TMDB_API_KEY + your Radarr / Sonarr URL and API key
uvicorn app.main:app --reload --port 8080
```

The frontend has no build step. Edit `app/static/*` and reload the page —
bump the `?v=` query on the `<link>`/`<script>` tags in `index.html` when you
change a static file, so browsers pick it up.

## Tests

```bash
pytest -q
```

The suite covers the paths that fail silently: health degradation when Radarr
is down, the TMDB Discover allowlist, cursor clamping, and auto-list
persistence. CI runs it and refuses to build the image if it fails, so a red
test blocks the release, not just the pull request.

Add a test when you fix a bug. One that fails before your change and passes
after is worth more than three that describe the happy path.

## What gets merged easily

- **Bug fixes**, with a test that pins the behaviour.
- **New TMDB filters.** Add the parameter to `DISCOVER_PARAMS` in
  `app/main.py`, the control in `index.html`, and the read in `collectFilters()`.
- **Translations.** See below — it is one object, no build step.
- **Accessibility fixes.** Always welcome, no discussion needed.

## What will be turned down

- A frontend framework, a bundler, or a CDN dependency. Serving one container
  with no build step is a feature of this project, not an oversight.
- A database in place of `lists.json`. The payloads are tiny and writes are
  atomic; SQLite would buy nothing here.
- Large refactors without a bug attached. `app/main.py` is long, and that is
  fine until it demonstrably causes a problem.

## Translations

`app/static/i18n.js` maps the English source string to its translation. Adding
a language is one entry in `LOCALES`:

```js
const LOCALES = {
  fr: { "Search": "Rechercher", /* … */ },
  de: { "Search": "Suchen", /* … */ },
};
```

The keys are the English strings themselves, so there is nothing to extract and
nothing to compile. Anything you leave out falls back to English. The interface
picks a language from the browser, and `localStorage["ui-lang"]` overrides it.

## Style

- Python: type hints, and a docstring on anything whose reason to exist is not
  obvious from its name. Explain *why*, not *what*.
- JavaScript: no dependencies, no build. Build DOM nodes rather than assigning
  `innerHTML` when any part of the content comes from TMDB, Radarr, Sonarr or a
  saved list.
- Every string a user reads goes through `tr()` and gets an entry in the French
  dictionary, so the other locale never silently rots.
- Comments in English.

## Pull requests

One change per pull request. Say what breaks without it. Screenshots for
anything visual, and a note about what you actually ran to check it.
