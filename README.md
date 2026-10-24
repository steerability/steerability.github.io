# steerability.github.io

One repo, three sites, one deploy:

| Folder | URL | What |
| --- | --- | --- |
| `landing/` | [steerability.github.io](https://steerability.github.io) | Static landing page |
| `lab/` | [/lab](https://steerability.github.io/lab) | AAAI 2026 lab site (Astro) |
| `competition/` | [/competition](https://steerability.github.io/competition) | NeurIPS 2026 competition site (plain HTML + CSS, no build) |

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds the lab site and
deploys it to GitHub Pages together with `landing/`, `competition/` and `shared/`.

## Local development

    scripts/preview.sh              # the assembled site, http://localhost:8000/
    scripts/preview.sh --with-lab   # also builds the lab site first

Re-run it after editing files. For the lab site on its own: `cd lab && pnpm install && pnpm dev`.

## Landing page

`landing/index.html` gets its effects from `landing/steer-engine.js`; keep
`landing/THIRD-PARTY.md` (its license notices) alongside it. The page styles are the
`[data-style]` token blocks at the top of `landing/styles.css`.

## Competition page

Sign-in and the leaderboard pop-up, including a mock mode for working locally, are
described at the top of `competition/hf-login.js` and
`competition/leaderboard/private-view.js`. To update the leaderboard table:

    python3 scripts/update-board.py --dry-run   # show the change
    python3 scripts/update-board.py             # write it

then review the diff in `competition/index.html` and commit.

## Notes

- `base` in `lab/astro.config.ts` (`/lab`) must match the folder the workflow copies
  the lab build to.
- `landing/404.html` is the site's only 404 page; the lab's own is built but not served.
