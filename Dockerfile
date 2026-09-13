FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
ENV FREE_VIDEO_SPACE=alexcheng0072/wan27-free-video-generator
ENV FREE_VIDEO_DURATION_SECONDS=3
ENV PAID_VIDEO_ENABLED=false
ENV VIDEO_API_URL=http://127.0.0.1:3000/api/v1/videos
ENV VIDEO_API_KEY=free-local-video
EXPOSE 3000
CMD ["node", "--import", "./ai-fix.mjs", "--import", "./runtime-fix.mjs", "--import", "./video-fix.mjs", "--import", "./ui-fix.mjs", "server.js"]
