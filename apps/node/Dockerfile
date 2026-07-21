# Build from the repo root: docker build -f apps/node/Dockerfile .
# Node >= 24: the adapter uses the built-in node:sqlite (zero native deps).
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/node ./apps/node
COPY apps/cloudflare/package.json ./apps/cloudflare/package.json
COPY migrations ./migrations

# apps/cloudflare's deps (wrangler et al.) aren't needed to run the Node adapter.
RUN npm ci --omit=dev --workspace @sunup/node --workspace @sunup/core --workspace @sunup/slack-app

ENV PORT=8787 DB_PATH=/data/sunup.db
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "apps/node/src/index.ts"]
