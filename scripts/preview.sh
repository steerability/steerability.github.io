#!/usr/bin/env bash
# Preview the site locally, assembled exactly as .github/workflows/deploy.yml assembles it:
#   _site/              <- landing/ + shared/
#   _site/competition/  <- competition/
#   _site/lab/          <- lab/dist (only if it has been built; --with-lab builds it)
# then serves _site/ so that absolute paths (/shared/..., /logo-light.svg) and the
# /competition/ base resolve the same way they do on steerability.github.io.
#
#   scripts/preview.sh              # http://localhost:8000/competition/
#   PORT=4000 scripts/preview.sh    # another port (the Hugging Face redirect URI accepts any localhost port)
#   scripts/preview.sh --with-lab   # also build the Astro lab site with pnpm first
#
# Re-run after editing files (assembly is a copy, it takes well under a second).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--with-lab" ]]; then
  (cd lab && pnpm install --frozen-lockfile && pnpm build)
fi

rm -rf _site
mkdir -p _site/competition
cp -r landing/. _site/
cp -r competition/. _site/competition/
cp -r shared/. _site/
if [[ -d lab/dist ]]; then cp -r lab/dist _site/lab; fi

PORT="${PORT:-8000}"
if (echo > "/dev/tcp/localhost/${PORT}") 2>/dev/null; then
  echo "Port ${PORT} is already in use. If that is an earlier preview, it is now serving the refreshed _site/;" >&2
  echo "otherwise stop whatever holds the port, or pick another: PORT=8001 scripts/preview.sh" >&2
  exit 1
fi
echo "Serving the assembled site from _site/"
echo "  competition:  http://localhost:${PORT}/competition/"
echo "  landing:      http://localhost:${PORT}/"
echo "  sign-in:      http://localhost:${PORT}/competition/?preview   (the button is hidden while CONFIG.enabled is false)"
echo "  mock session: http://localhost:${PORT}/competition/leaderboard/?mock=participant   (also: participant-unscored |"
echo "                participant-noentry | organizer | noteam | none; ?mock=off ends mock mode; fixtures in leaderboard/mock/)"
echo "Ctrl-C to stop."
exec python3 -m http.server "${PORT}" --directory _site
