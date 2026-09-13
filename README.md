# SQ AI

SQ AI is an AI creation workspace for content, ads, images, campaigns, and short video generation.

## Current architecture
- Express production server
- SQLite persistence with WAL
- Cookie sessions and API-key authentication
- Credits and usage metering
- Text generation through OpenRouter
- Image generation through OpenRouter
- Free video generation through a public Hugging Face ZeroGPU Gradio Space
- Optional paid video path, disabled by default
- Docker production deployment
- Terms, privacy, and refund pages

## Run locally
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Main API
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/usage`
- `GET /api/projects`
- `POST /api/projects`
- `DELETE /api/projects/:id`
- `PATCH /api/account`
- `POST /api/tools/generate`
- `POST /api/campaigns/generate`
- `GET /api/plans`
- `GET /api/health`

## Free video mode
The default Docker configuration routes video generation to the public Hugging Face ZeroGPU Space configured by `FREE_VIDEO_SPACE`. The current adapter uses the Space's `generate_video` Gradio endpoint with a text prompt, fixed aspect ratio, and 2–5 second duration.

The application stores generated files under `/app/data/generated-videos` when the free adapter returns a local file. The generated-video directory is served at `/generated-videos/`.

## Billing
Paddle checkout is intentionally not enabled in the server yet. `/api/billing/checkout` returns `501` until the real Paddle checkout/webhook integration is configured.

## Important
Provider credentials must be supplied through environment variables. Never commit real API keys to GitHub.

## Deployment
Abasthan auto-deploys the `main` branch. This line intentionally refreshes the service after a platform/runtime restart.
