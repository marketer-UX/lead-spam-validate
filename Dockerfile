# validate service — multi-stage build; runs on any Docker host or PaaS.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.embed.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runner
RUN apk add --no-cache curl ca-certificates
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -fs http://localhost:8787/health > /dev/null || exit 1
USER node
CMD ["node", "dist/server/index.js"]
