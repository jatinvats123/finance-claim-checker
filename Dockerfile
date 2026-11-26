# Public demo image for the web verification workspace (`npm run web`).
# Runs the keyless included example only: do NOT pass any model provider key
# (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) to this container on a public host.
FROM node:24.13.0-slim

WORKDIR /app

# tsx (runs the TypeScript server) and vite (builds the frontend) are devDependencies,
# so install them too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# Source, frontend and the data the keyless example replays (data/replay, data/sec-snapshot, data/articles).
COPY . .
RUN npx vite build

# Host platforms route traffic to $PORT on all interfaces. Render/Railway inject their own PORT;
# 8080 is the default for Fly.io and plain `docker run`.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

# The server only reads files; no need for root.
USER node
CMD ["node", "--import", "tsx", "src/web/server.ts"]
