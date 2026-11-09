# The QAuth server image with this plugin added the way an operator adds it
# (QAuth's docs: operate/images, "Add a plugin to the image"). The plugin is
# the tarball `pnpm pack` made of this checkout, the same file npm would
# receive; run.sh puts it at .work/plugin.tgz.
#
# QAUTH_IMAGE is the server image compose.yml passes in: until a released
# image carries the preset loader (qauth-labs/qauth#671), the one
# qauth-images.sh builds from the commit e2e/qauth-commit names.
#
# TEMPORARY, without npm: the plugin's SDK is a file: dependency on the
# vendored tarball (vendor/README.md), which cannot resolve inside the image.
# So the plugin and its own copy of the SDK are unpacked where a nested
# `npm install` would put them, without the SDK's peer dependency, so the
# plugin uses the server's zod. The SDK has no dependencies. Once the SDK is
# on npm, this stage goes back to the operator's install:
#
#   RUN npm init --yes > /dev/null \
#    && npm install --omit=dev --omit=peer --install-strategy=nested --ignore-scripts /tmp/plugin.tgz
ARG QAUTH_IMAGE

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS plugin
WORKDIR /plugin
COPY .work/plugin.tgz /tmp/plugin.tgz
COPY .work/plugin-sdk.tgz /tmp/plugin-sdk.tgz
RUN set -eu; \
    plugin=node_modules/@qauth-labs/plugin-apple; \
    sdk="$plugin/node_modules/@qauth-labs/plugin-sdk"; \
    mkdir -p "$plugin" "$sdk"; \
    tar -xzf /tmp/plugin.tgz -C "$plugin" --strip-components=1; \
    tar -xzf /tmp/plugin-sdk.tgz -C "$sdk" --strip-components=1; \
    test -f "$plugin/dist/index.js"; \
    test -f "$sdk/dist/index.js"

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-apple \
  /app/node_modules/@qauth-labs/plugin-apple
