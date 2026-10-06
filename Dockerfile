FROM node:22-alpine

WORKDIR /app

# Dependencies first (cached until package files change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# /data keeps the link-signing secret across restarts (mount a volume there)
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=7000 DATA_DIR=/data
USER node

EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["npx", "tsx", "src/index.ts"]
