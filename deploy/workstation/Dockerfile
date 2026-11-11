# 程序即工作站：账号、主机登记、会话与 agent 都在这个服务里。
# 构建：在仓库根目录 docker build -f deploy/workstation/Dockerfile -t tandem-workstation .
# 只发布到内网；不要做公网端口映射或反向代理。
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY tsconfig*.json ./
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TANDEM_HOME=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8481
CMD ["node", "packages/server/dist/cli.js", "--host", "0.0.0.0", "--port", "8481"]
