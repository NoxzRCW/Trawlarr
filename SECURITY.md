# Security policy

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/NoxzRCW/Trawlarr/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. A proof of concept
helps. Expect a first reply within a week; this is a personal project, not a
company with an on-call rota.

## What is in scope

Trawlarr holds your TMDB, Radarr, Sonarr and (optionally) Mistral API keys, and
it talks to your *arr instances on your behalf. Things worth reporting:

- any way to make a credential reach the browser, the logs, or an error message
- any way to make the server issue a request to a host it was not configured for
- injection into the parameters forwarded to TMDB, Radarr or Sonarr
- stored content from TMDB or your library that ends up executed in the page
- a way to write outside `DATA_DIR`

## What is not

**Trawlarr has no authentication, by design.** It is meant to sit on a private
network, behind whatever already protects your Radarr and Sonarr. The bundled
compose file binds to `127.0.0.1` for that reason. "There is no login page" is
therefore not a vulnerability — exposing the port to the Internet is a
deployment decision, and the README says so.

Likewise out of scope: findings that require an attacker to already have shell
access to the host or to the container, and vulnerabilities in TMDB, Radarr,
Sonarr or Mistral themselves.

## Supported versions

The latest release and `main`. There are no backports.
