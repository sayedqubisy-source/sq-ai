# SQ AI

SQ AI is an AI creation workspace for content, ads, images, campaigns, and short video generation.

## Architecture
- Express 5 production server
- SQLite persistence with WAL
- Cookie sessions and API-key authentication
- Credits and usage metering
- OpenRouter text and image generation
- Free video generation through the public Hugging Face ZeroGPU Gradio Space
- Persistent asynchronous video jobs with a single-worker queue
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
The default configuration uses `alexcheng0072/wan27-free-video-generator` through Hugging Face Gradio's queue API. The current Space accepts four inputs: optional first-frame image, prompt, fixed aspect ratio, and a 2–5 second duration. SQ AI serializes its own video jobs so multiple users do not hit the public ZeroGPU Space concurrently.

Generated MP4 files are stored under the directory beside the SQLite database and served through `/generated-videos/`. The application removes generated files older than 24 hours.

The free provider is external infrastructure, so its queue and daily ZeroGPU quota can still affect availability. SQ AI handles provider failures, timeouts, queueing, and credit refunds without charging a failed generation.

## Billing
Paddle checkout is wired through `billing-fix.mjs`. It requires the Paddle API key, webhook secret, and the three configured Paddle price IDs. When those variables are absent, checkout fails safely with a configuration error instead of pretending that payment is enabled.

## Environment
Copy `.env.example` to your deployment environment and provide real provider credentials there. Never commit API keys, webhook secrets, or customer data to GitHub.

## Deployment
Abasthan can auto-deploy the `main` branch. The application listens on `process.env.PORT` and `0.0.0.0` for reverse-proxy deployment.
