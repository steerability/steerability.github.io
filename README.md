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
in a pop-up window, where sign-in (`competition/hf-login.js`) and the board with its private
view (`competition/leaderboard/private-view.js`) live; the board comes from the results API,
one week at a time.
It works on the local preview too — the Hugging Face app accepts
`http://localhost/competition/leaderboard/` on any port — and `?mock=participant` /
`?mock=organizer` (on either page) fake a signed-in session without leaving the page and
put the pop-up in mock mode, where it reads the fixtures in `competition/leaderboard/mock/`
instead of calling the results API: `runs.json` (the index of weeks), `board.<run>.json`
(a week's public table), and `<kind>.json` for the latest week or `<kind>.<run>.json` for
another (`participant`, `participant-unscored`, `participant-noentry`, `organizer`; the
`.week_01` files are the earlier week and the `.week_03` files the week being evaluated,
which the index's `pending` block adds as one more step of the picker, in the phase its
`phase` names; `participant-unscored.week_03.json` is a submission that did not pass the
intake checks; a week without a file for the kind shows as having no entry). Mock mode
stays on through `?mock=none`, reloads and sign-out; `?mock=off` ends it.
`CONFIG.enabled` in `competition/hf-login.js` is a kill switch for the button: set to
`false`, it hides the button for everyone but browsers that have visited the competition
page with `?preview` (on the live site too), which is how to look at a deploy made dark.
`CONFIG.pendingProgress` says how much of the week being evaluated a team's drawer shows:
`'coarse'` (the default) reads every model of every submission as in progress until the
board is published; `'detailed'` shows each model's own state (a participant sees completed,
error or in progress, an organizer the raw codes). An organizer can switch their own browser
with `?progress=detailed` or `?progress=coarse` on either page, and back to the site's
setting with `?progress=site`; it never changes what anyone else sees.

## Updating the leaderboard on the competition page

The table on the competition page is static HTML. A script writes its rows from the
results API, in the page's own markup, and touches nothing else:

    python3 scripts/update-board.py --dry-run   # show the change
    python3 scripts/update-board.py             # write it (the latest published week; --run week_01 for another)

Review the diff in `competition/index.html` and commit; pushing `main` deploys it. The
pop-up reads the API itself and needs no update. The script writes nothing when the API
cannot be reached or its answer looks wrong.

## Notes

- The lab site's `base` in `lab/astro.config.ts` (`/lab`) must match the folder name
  used in the Assemble step; the competition page has no build and is copied to
  `/competition` as is.
- The lab site uses pnpm (`pnpm-lock.yaml`); the workflow installs with
  `--frozen-lockfile`. A failed lab build fails the deploy, leaving the previous
  deployment live.
- GitHub Pages serves a single `404.html` from the site root (`landing/404.html`);
  the lab's Astro 404 page is built but not used.
