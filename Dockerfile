# syntax=docker/dockerfile:1

# This stage runs on the builder's own architecture, also for an image meant for another one:
# what it produces is plain JavaScript, and Node crashes when it is emulated.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
COPY test ./test
# A failing test fails the build, so the deploy stops and the running version stays up.
RUN npm test
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk upgrade --no-cache
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY LICENSE ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
