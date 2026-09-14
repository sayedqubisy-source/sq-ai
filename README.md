# SQ AI

SQ AI is an AI creation workspace for content, ads, images, campaigns, and short video generation.

## Architecture
- Express 5 production server
- SQLite persistence with WAL
- Cookie sessions and API-key authentication
- Credits and usage metering
- OpenRouter text and image generation
- Free video generation through the public Hugging Face ZeroGPU Gradio Space
- Video generation starts immediately from SQ AI without an internal video queue
- Video size selection: 9:16 vertical, 16:9 landscape, and 1:1 square
- Light application interface with persistent video-size preference
- Optional Paddle billing integration, enabled when the required environment variables are configured
- Docker production deployment on Abasthan
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
- `POST /api/auth/set-password`
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
The default configuration uses `alexcheng0072/wan27-free-video-generator` through Hugging Face Gradio's ZeroGPU API. SQ AI sends video generation directly to the external provider without adding its own internal queue. The external GPU service may still have its own scheduling, quota, or inference time.

Supported output sizes are mapped to the provider's available resolutions:
- Vertical 9:16: 480x832
- Landscape 16:9: 832x480
- Square 1:1: 640x640

Generated MP4 files are stored under the directory beside the SQLite database and served through `/generated-videos/`. The application removes generated files older than 24 hours.

## Billing
Paddle checkout is wired through `billing-fix.mjs`. It requires the Paddle API key, webhook secret, and the three configured Paddle price IDs. When those variables are absent, checkout fails safely with a configuration error instead of pretending that payment is enabled.

## Environment
Copy `.env.example` to your deployment environment and provide real provider credentials there. Never commit API keys, webhook secrets, or customer data to GitHub.

## Deployment
Abasthan can auto-deploy the `main` branch. The application listens on `process.env.PORT` and `0.0.0.0` for reverse-proxy deployment.

## Latest UI
The startup UI patch injects the light theme and video-size selector into the served application and removes stale copies of the injected scripts before adding the current versions.