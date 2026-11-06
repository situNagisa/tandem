FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/mobile/package.json packages/mobile/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

COPY packages/relay packages/relay
RUN npm run build -w @tandem/relay
RUN npm prune --omit=dev

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/relay/package.json packages/relay/package.json
COPY --from=build /app/packages/relay/dist packages/relay/dist

RUN mkdir /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node

EXPOSE 7950
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:7950/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "packages/relay/dist/cli.js"]
CMD ["--host", "0.0.0.0", "--port", "7950", "--trust-proxy", "--data", "/data"]
