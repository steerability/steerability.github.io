# steerability.github.io

One repo, three sites, one deploy:

| Folder | URL | What |
| --- | --- | --- |
| `landing/` | [steerability.github.io](https://steerability.github.io) | Static landing page + events timeline |
| `lab/` | [/lab](https://steerability.github.io/lab) | AAAI 2026 lab site (Astro) |
| `competition/` | [/competition](https://steerability.github.io/competition) | NeurIPS 2026 competition site (plain HTML + CSS, no build) |

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the Astro lab
site with pnpm, assembles it with the landing page, the competition page and `shared/`
into `_site/`, and deploys the result to GitHub Pages.

## Local development

To see the whole site as it will be deployed (absolute paths like `/shared/...` and the
`/competition/` base only resolve once the folders are assembled):

    scripts/preview.sh              # http://localhost:8000/competition/
    scripts/preview.sh --with-lab   # also builds the Astro lab site first

Re-run it after editing files. For the Astro lab site on its own:

    cd lab
    pnpm install
    pnpm dev          # serves at the site's base path, localhost:4321/lab

The competition page's "Sign in with Hugging Face" button opens `competition/leaderboard/`
in a pop-up window, where sign-in (`competition/hf-login.js`) and the private view live.
It works on the local preview too — the Hugging Face app accepts
`http://localhost/competition/leaderboard/` on any port — and `?mock=participant` /
`?mock=organizer` (on either page) fake a signed-in session without leaving the page; the
pop-up's private view then renders the fixture `competition/leaderboard/mock/<kind>.json`
(also `participant-unscored`, `participant-late` and `participant-noentry`) instead of
calling the results API.
While `CONFIG.enabled` is `false` the button is hidden; add `?preview` to the competition
page's URL to show it (on the live site too).

## Notes

- The lab site's `base` in `lab/astro.config.ts` (`/lab`) must match the folder name
  used in the Assemble step; the competition page has no build and is copied to
  `/competition` as is.
- The lab site uses pnpm (`pnpm-lock.yaml`); the workflow installs with
  `--frozen-lockfile`. A failed lab build fails the deploy, leaving the previous
  deployment live.
- GitHub Pages serves a single `404.html` from the site root (`landing/404.html`);
  the lab's Astro 404 page is built but not used.
