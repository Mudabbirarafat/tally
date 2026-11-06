# The sync server, and nothing else.
#
# No npm install, no build step and no package manager in the image: the
# server imports only `node:http` and `node:sqlite`, and Node runs the
# TypeScript by stripping types. That is why this file is six lines rather
# than a multi-stage build.
#
# Node 24 because `node:sqlite` needs 22.5 or later, and because type
# stripping is enabled by default from 23 onwards.
FROM node:24-slim

WORKDIR /app

# Only the server. The React Native app is built and hosted separately; it
# has no business in this image.
COPY server/ ./server/

# /data is a Fly volume. The whole point of attaching one is that the
# ledger outlives a restart - without it the server loses the shared log and
# every client silently stops syncing, because each one believes it has
# already pushed.
ENV PORT=8080 \
    DATABASE_PATH=/data/tally.sqlite \
    NODE_ENV=production

EXPOSE 8080

CMD ["node", "server/src/main.ts"]
