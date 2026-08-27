#!/bin/sh
#
# Bring the schema up to date, then start the server.
#
# `migrate deploy` only applies migrations that already exist in the image — it
# never generates one and never resets anything, which is what makes it safe to
# run unattended on every boot. If it fails, the container must not start: a
# server running against a schema it does not understand corrupts data rather
# than refusing to.
set -eu

echo "wolffmsg: applying database migrations"
# The binary directly rather than through npx: npx adds a resolution step and a
# cache directory it may want to write to, and neither earns its keep when the
# CLI is installed right here.
./node_modules/.bin/prisma migrate deploy --schema packages/server/prisma/schema.prisma

echo "wolffmsg: starting server"
exec "$@"
