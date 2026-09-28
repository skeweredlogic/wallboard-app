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
| `PORT` | `8000` | HTTP port to listen on |

## Endpoints

- `GET /healthz` - Health check (used by probes)
- `GET /api/state` - Current calendar state (JSON)