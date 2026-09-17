FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/sq-ai.sqlite \
    FREE_VIDEO_SPACE=alexcheng0072/wan27-free-video-generator \
    FREE_VIDEO_DURATION_SECONDS=3 \
    PAID_VIDEO_ENABLED=false \
    MEDIA_PROMPT_ENHANCER=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node

# Keep production and local startup identical so every route/patch used by
# the application is actually loaded in the deployed container.
CMD ["npm", "start"]
