FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --chown=node:node package.json ./
COPY --chown=node:node ghost_replay/ ./ghost_replay/
COPY --chown=node:node service/ ./service/
COPY --chown=node:node web/ ./web/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "service/healthcheck.mjs"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "service/main.mjs"]
