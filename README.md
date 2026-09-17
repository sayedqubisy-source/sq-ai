# SQ AI

SQ AI is an AI creation workspace for content, ads, images, campaigns, and short video generation.

## Architecture
- Express 5 production server
- SQLite persistence with WAL
- Cookie sessions and API-key authentication
- Credits and usage metering
- OpenRouter text generation with optional direct Gemini image generation
- Free video generation through the public Hugging Face ZeroGPU Gradio Space
- Durable, user-scoped video jobs with automatic credit refunds on failure or restart
- Music generation through the public Hugging Face MusicGen Space
- Video size selection: 9:16 vertical, 16:9 landscape, and 1:1 square
- Light application interface with persistent video-size preference
- Optional Paddle billing integration, enabled when the required environment variables are configured
- Docker production deployment on Abasthan
- Terms, privacy, and refund pages

## Run locally
```bash
npm ci
npm start
```
Open `http://localhost:3000`.

## Main API
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `PATCH /api/account`
- `GET /api/usage`
- `GET /api/projects`
- `POST /api/projects`
- `DELETE /api/projects/:id`
- `POST /api/tools/generate`
- `GET /api/tools/video-job/:id`
- `POST /api/campaigns/generate`
- `GET /api/plans`
- `POST /api/billing/checkout`
- `POST /api/webhooks/paddle`
- `GET /api/health`

## Free video mode
The default configuration uses `alexcheng0072/wan27-free-video-generator` through Hugging Face Gradio's ZeroGPU API. SQ AI records a lightweight job locally so the browser can poll progress safely. The external GPU service may still have its own scheduling, quota, downtime, or inference delay.

Supported output sizes are mapped to the provider's available resolutions:
- Vertical 9:16: 480x832
- Landscape 16:9: 832x480
- Square 1:1: 640x640

Generated MP4 files are validated, size-limited, stored under the directory beside the SQLite database, and served only to authenticated users through `/generated-videos/`. The application removes generated files and completed job records older than 24 hours.

## Billing
Paddle checkout is wired through `billing-fix.mjs`. It requires the Paddle API key, webhook secret, and the three configured Paddle price IDs. When those variables are absent, checkout fails safely with a configuration error instead of pretending that payment is enabled.

## Environment
Copy `.env.example` to your deployment environment and provide real provider credentials there. Never commit API keys, webhook secrets, or customer data to GitHub.

## Deployment
Abasthan can auto-deploy the `main` branch. The application listens on `process.env.PORT` and `0.0.0.0` for reverse-proxy deployment.

## Media providers

Text generation uses the first configured provider supported by `ai/runtime.mjs`. Image generation requires `GEMINI_API_KEY`. Music uses the public MusicGen Space by default and can use `HF_TOKEN` for authenticated Hugging Face requests. Free video does not call Veo even when a Gemini key is configured. Setting `FAL_KEY` enables paid Wan 2.2 Turbo video automatically; `FAL_VIDEO_RESOLUTION` controls its 480p, 580p, or 720p tier. Other paid video providers require `PAID_VIDEO_ENABLED=true` and either a custom video API or a Gemini key.

All interface scripts are included directly in the static pages. Startup does not rewrite application source files.

## Maintenance checks

Run `npm test` for isolated regression tests and `npm run smoke` for the production startup check. The regression suite uses mocked AI providers and a temporary database; it does not spend provider credits or change customer data. CI also builds and health-checks the Docker image.

Set `TRUST_PROXY=1` only when the application is behind one trusted reverse proxy. Direct deployments should retain `TRUST_PROXY=false`. Multiple proxy hops can be configured with a positive integer. The proxy must overwrite the forwarded headers.

The server exposes `/api/health`, handles `SIGTERM`/`SIGINT` gracefully, limits request and provider response sizes, applies rate limits and security headers, and returns safe production errors.
