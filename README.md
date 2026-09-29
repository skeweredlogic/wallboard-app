# wallboard

Python/FastAPI app for aggregating and displaying family calendars on a wall-mounted display.

## Quick Start

```bash
# Install dependencies
poetry install

# Generate OAuth2 token (one-time)
poetry run python scripts/generate_token.py

# Store token in Vault
vault kv put secret/infra/wallboard-token token_json=@token.json
```

## OAuth2 Setup (One-Time)

1. Run `poetry run python scripts/generate_token.py`
2. A browser window will open - log in with `rjacobchick@gmail.com`
3. Grant **View your calendars** permission
4. The script saves `token.json` locally
5. Store securely in Vault: `vault kv put secret/infra/wallboard-token token_json=@token.json`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CREDENTIALS_PATH` | `/app/config/token.json` | Path to OAuth2 token file in container |
| `CALENDAR_IDS` | `""` (all shared) | Comma-separated calendar IDs to display |
| `CALENDAR_COLORS` | `{}` | JSON mapping of calendar ID → hex color |
| `CACHE_TTL_SECONDS` | `300` | How often to poll Google Calendar |
| `LOOKAHEAD_DAYS` | `90` | How many days of future events to fetch |
| `LOOKBACK_DAYS` | `365` | How many days of past events to fetch (reachable by stepping back in the agenda) |
| `TIMEZONE` | `America/New_York` | Timezone used to bucket events by day |
| `ATTENDEE_ALIASES` | `{}` | JSON map of attendee email → friendly name, e.g. `{"a@b.com":"Tina"}`. Set per-deployment. |
| `INDEX_PATH` | `/app/index.html` | Path to the wallboard HTML page |
| `PORT` | `8000` | HTTP port to listen on |

## Endpoints

- `GET /` - The wallboard UI. Agenda (one day, arrows step by day) / Week / Month views,
  per-calendar filter chips, clickable events with a detail modal (When / Where / Duration /
  Attendees / Notes + Google link), and duration/space-aware rendering. Layout is responsive:
  the default sizing targets a wall panel, and a small-screen breakpoint switches to a
  touch-sized layout (44px+ tap targets, sideways-scrolling week).
- `GET /health` / `GET /healthz` - Health check (used by probes)
- `GET /api/state` - Calendar list, upcoming events, `can_write` capability, and the
  server's `version` (JSON). The page stores that version and reloads itself when it
  changes, so an always-on wallboard display picks up new builds unattended.
- `POST /api/events/move` - Move an event to another displayed calendar.
  Body: `{"event_id": "...", "from_calendar": "...", "to_calendar": "..."}`.
  Requires a **write-scoped** token (see below); returns 403 otherwise.

## Write access (moving events between calendars)

The UI only offers "move to calendar" when the token grants write scope. The
default/read-only token hides the control and `POST /api/events/move` returns 403.

To enable it, re-run the OAuth flow with the broader `calendar` scope and update Vault:

```bash
# 1. Re-authorize (opens a browser; grants full calendar read/write)
poetry run python scripts/generate_token.py --force

# 2. Push the new token into Vault (VSO syncs it to the pod secret)
vault kv put secret/infra/wallboard-token token_json=@token.json

# 3. Restart so the mounted secret is re-read
kubectl rollout restart deploy/wallboard -n wallboard
```

`can_write` flips to `true` on the next sync; the modal then shows the calendar
dropdown.

## Tests

The UI is a single `index.html` driven by a handful of globals, so it is tested by
running the real file in jsdom against a fake `/api/state` payload. No browser, no
server, no real calendar data:

```bash
npm ci
npm test            # versions + UI behaviour + reload-loop regression
```

| Script | What it does |
| --- | --- |
| `npm test` | Everything below. This is what CI runs before it will build an image. |
| `npm run test:ui` | 37 assertions on the UI: chips, day stepping, modal, filtering, views, responsive CSS, location/attendees. |
| `npm run test:reload` | Regression test for the self-update reload loop (see below). |
| `npm run test:live` | The same suites against the running deployment, via its real API. |
| `npm run measure` | Launches headless Chrome and prints computed element sizes at phone/tablet/wall viewports. Needs a reachable URL. |

`tests/fixture.js` generates the fake payload relative to *today*, so the tests do
not rot as the calendar ages, and no family calendar data is ever committed or
printed in CI.

### The reload-loop regression test

`checkVersion()` reloads the page when the server reports a newer build than the
page was loaded with, so an always-on display picks up releases unattended. In
0.3.2 and 0.4.0 it reloaded *before* recording the new version, so the mismatch
survived the reload and the page reloaded forever — roughly nine times a second,
visible in the pod access log as a storm of `GET /`. `tests/reload.test.js` seeds
a stale version into `localStorage` and counts reload attempts (jsdom reports each
one as an unimplemented navigation). It fails against the old code and passes
against the fix, so it is worth running before any change to that logic or to
`APP_VERSION`.

`tests/versions.test.js` also asserts `APP_VERSION` and the `pyproject.toml`
version agree. If they drift, every open tab reloads forever after a rollout,
which is the same failure from a different direction.