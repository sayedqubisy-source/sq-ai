FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
ENV FREE_VIDEO_SPACE=alexcheng0072/wan27-free-video-generator
ENV FREE_VIDEO_DURATION_SECONDS=3
ENV PAID_VIDEO_ENABLED=false
EXPOSE 3000
CMD ["node", "server.js"]
