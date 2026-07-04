# steerability.github.io

One repo, three sites, one deploy:

| Folder | URL | What |
| --- | --- | --- |
| `landing/` | [steerability.github.io](https://steerability.github.io) | Static landing page + events timeline |
| `lab/` | [/lab](https://steerability.github.io/lab) | AAAI 2026 lab site (Astro) |
| `competition/` | [/competition](https://steerability.github.io/competition) | NeurIPS 2026 competition site (Astro) |

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds both Astro
sites with pnpm, assembles them with the landing page into `_site/`, and deploys the
result to GitHub Pages.

## Local development

The landing page is plain HTML — just open `landing/index.html`. For the Astro sites:

    cd lab            # or: cd competition
    pnpm install
    pnpm dev          # serves at the site's base path, e.g. localhost:4321/competition

## Notes

- Each Astro site keeps its own `base` in `astro.config.ts` (`/lab`, `/competition`).
  Don't change these — they must match the folder names used in the Assemble step.
- Both Astro sites use pnpm (`pnpm-lock.yaml`); the workflow installs with
  `--frozen-lockfile`. A failed build in either site fails the deploy, leaving the
  previous deployment live.
- GitHub Pages serves a single `404.html` from the site root (`landing/404.html`);
  the per-site Astro 404 pages are built but not used.
