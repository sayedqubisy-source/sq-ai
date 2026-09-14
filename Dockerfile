FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/sq-ai.sqlite \
    FREE_VIDEO_SPACE=alexcheng0072/wan27-free-video-generator \
    FREE_VIDEO_DURATION_SECONDS=3 \
    PAID_VIDEO_ENABLED=false

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "./sqai-bridge.mjs", "--import", "./auto-recovery.mjs", "--import", "./billing-fix.mjs", "--import", "./ui-fix.mjs", "--import", "./video-fix.mjs", "--import", "./video-jobs-fix.mjs", "server.js"]
