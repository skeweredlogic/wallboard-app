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
| `LOOKBACK_DAYS` | `35` | How many days of past events to fetch |
| `TIMEZONE` | `America/New_York` | Timezone used to bucket events by day |
| `INDEX_PATH` | `/app/index.html` | Path to the wallboard HTML page |
| `PORT` | `8000` | HTTP port to listen on |

## Endpoints

- `GET /` - The wallboard UI. Three views (Agenda / Week / Month), per-calendar
  filter chips, clickable events with a detail modal, and duration/space-aware
  rendering (event blocks are sized by how long they last).
- `GET /health` / `GET /healthz` - Health check (used by probes)
- `GET /api/state` - Calendar list, upcoming events, and `can_write` capability (JSON)
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