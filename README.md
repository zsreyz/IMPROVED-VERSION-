# AI Founder OS (Improved Version)

## Quick start (no npm install required)

```bash
# optional: export your Anthropic key
export ANTHROPIC_API_KEY=your_key_here

# run server
npm start
```

Open `http://localhost:3000`.

## Why this fixes the 404 issue

- Added `index.html` so opening the project root no longer shows 404.
- Server now falls back to `index.html` for unknown frontend routes.

## Backend endpoints

- `GET /api/health` — backend health/status for dashboard.
- `POST /api/mentor` — secure AI mentor proxy with validation + rate limiting.
