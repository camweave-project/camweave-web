FROM node:24-alpine
LABEL org.opencontainers.image.title="CamWeave Web" \
      org.opencontainers.image.description="Self-hosted multi-camera viewer for desktop and mobile browsers" \
      org.opencontainers.image.source="https://github.com/camweave-project/camweave-web" \
      org.opencontainers.image.url="https://camweave.com" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
WORKDIR /app
COPY --chown=node:node package.json server.mjs LICENSE ./
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
