# The Steerability Challenge — competition website

Website for the NeurIPS 2026 competition **The Steerability Challenge**, served at
[steerability.github.io/competition](https://steerability.github.io/competition).

Built with [Astro](https://astro.build) on the same theme as the
[lab site](https://steerability.github.io/lab) (Astro Cactus: Tailwind 4, mono type,
light/dark themes).

## Editing

Almost everything lives in a handful of files:

| What | Where |
| --- | --- |
| Page content (overview, task, rules, schedule, organizers) | `src/pages/index.astro` |
| Header (title, dates, venue) | `src/components/layout/Header.astro` |
| Site title / description / URL | `src/site.config.ts` |
| Theme colors and typography | `src/styles/global.css` |
| Base path (`/competition`) | `astro.config.ts` |

Placeholders to fill in at launch: registration/submission links (the dashed notice box at
the top of `index.astro`), the designated base model, the prize breakdown, and the
Discord/contact links.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # static build to ./dist
```

## Deployment

Push to `main` in a repo named `competition` under the `steerability` org. The included
GitHub Actions workflow (`.github/workflows/deploy.yml`) builds the site and deploys it to
GitHub Pages — set the repo's *Settings → Pages → Source* to **GitHub Actions** once.
