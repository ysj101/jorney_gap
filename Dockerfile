FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /src
RUN npm install --global pnpm@10.30.2
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm --filter @journeygap/relay deploy --prod --legacy /out

FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4318
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 CMD node -e "fetch('http://127.0.0.1:4318/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js", "--config", "/config/journeygap.relay.json", "--db", "/data/journeygap.db", "--host", "0.0.0.0"]
