# Build from the repository root: docker build -t exolvra-genesis:local .
# The application has no hosting-provider dependency. Put TLS at your proxy.
FROM node:22-bookworm-slim AS build
WORKDIR /source/cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci
COPY . /source
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client procps ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/genesis /workspace \
    && chown node:node /opt/genesis /workspace
WORKDIR /workspace
ENV NODE_ENV=production HOME=/home/node
COPY --from=build --chown=node:node /source/cli/package.json /source/cli/package-lock.json /source/cli/LICENSE /opt/genesis/
COPY --from=build --chown=node:node /source/cli/dist /opt/genesis/dist
COPY --from=build --chown=node:node /source/cli/node_modules /opt/genesis/node_modules
RUN chmod 755 /opt/genesis/dist/cli.js \
    && ln -s /opt/genesis/dist/cli.js /usr/local/bin/exolvra-genesis
USER node
EXPOSE 4317
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/genesis/dist/cli.js"]
# A network listener refuses to start without an access key and --public-url.
# The Compose example supplies both. Override CMD for other CLI commands.
CMD ["dashboard", "--directory", "/workspace", "--host", "0.0.0.0", "--port", "4317"]
