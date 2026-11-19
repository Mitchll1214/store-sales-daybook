# 店销日集 · 生产镜像
# 说明：运行时使用 Node 内置 node:sqlite（Node 22 需 --experimental-sqlite），无原生模块编译依赖。
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    APP_TZ_OFFSET=8 \
    TZ=Asia/Shanghai

WORKDIR /app

# su-exec 用于入口脚本降权；tzdata 保证容器内 TZ 生效
RUN apk add --no-cache su-exec tzdata

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 预置 ip2region xdb：优先上游下载，网络不可用时回退 npm 包内置版本（镜像仍可离线构建）
COPY scripts ./scripts
RUN node scripts/fetch-ipdb.js --out /app/vendor --fallback /app/node_modules/ip2region/data

COPY server.js ./
COPY src ./src
COPY public ./public

# 运行期数据目录（SQLite / 上传图片 / 在线更新的 IP 库），请挂载数据卷
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data /app/vendor \
    && chmod +x /app/scripts/docker-entrypoint.sh

# 以 root 启动入口脚本：先修正数据卷属主（首次挂载的空目录通常属于 root），
# 再通过 su-exec 降权到 node 运行服务，进程本身仍是非 root。
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--experimental-sqlite", "server.js"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
