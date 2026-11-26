# Disclosure Defenders

An arcade game for sustainability teams: five levels (Compliance, Risk, Double Materiality, Carbon Accounting, Stakeholders), a public high-score board, and share links.

Live: https://disclosure-defenders.pages.dev

## What's in here

- `site/` is the whole game: six static pages (one per level plus the home page) and share images in `site/og/`. No build step.
- `worker/scores-worker.js` is the high-score board, a Cloudflare Worker with a KV namespace bound as `SCORES`.

## Deploying

- **Game:** Cloudflare Pages. If the project is connected to this repo, set the build command to none and the output directory to `site`. Every push to `main` then redeploys automatically.
- **Score board:** paste `worker/scores-worker.js` into the `disclosure-defenders-scores` Worker in the Cloudflare dashboard and deploy. It is not deployed from this repo.

## Changing things

- The site address is baked into each page's share tags (canonical, `og:url`, `og:image`). If the address changes, find and replace it in all six pages.
- The score board address is set in `leaderboardUrl` near the top of each page's script.
- Scores store only a made-up name, score, difficulty, date and a random browser ID. No personal data.
