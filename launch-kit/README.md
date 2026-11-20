# $BLAME launch kit

Everything for launch day, in one folder. Nothing here changes the live site, and nothing is posted anywhere.

**Start here:** open `index.html` in your browser. It shows every image, the videos, X mock-ups and every check.

## What's in the folder

| Folder / file | What it is |
|---|---|
| `logo/` | The 3 logo options, the chosen logo (`logo.svg`), the Pons token image (`logo-1000x1000.png`), the X profile picture (`pfp-400x400.png`) and the site icons (`favicon.ico`, `favicon-32.png`, `apple-touch-icon-180.png`) |
| `x/` | X banner (`banner-1500x500.png`) and link preview (`og-1200x630.png`) |
| `posts/` | Post images, each in 1200x675 and 1080x1080: blame cards for $AI, $MEME, $BONER, the OBSYN fake-copy warning, the receipts card |
| `video/` | The promo video: square, wide, and wide with soft sounds, plus thumbnails and one frame per scene |
| `cards/` | Blame cards you make later with `npm run card` (one folder per day) |
| `posts.md` | Every post: X profile, Pons form, pinned post, launch thread, 10 report + 10 reply templates, "shipped" posts, copycat warnings, pre-launch posts |
| `og-meta-snippet.html` | The link-preview tags to paste into the site yourself |
| `config.json` | **The settings:** contract address (`"ca"`), which logo (`"logo"`), and the receipts lines |
| `checks/` | The latest check results |
| `tools/`, `video/src/` | The code that draws everything |

## Commands

Open Terminal and go to this folder first:

```bash
cd ~/Desktop/\$BLAME/launch-kit
```

Put the real contract address on everything (saves it in config.json, re-renders all images and videos, re-checks):

```bash
npm run kit -- --ca 0xYOUR_CONTRACT_ADDRESS
```

Make a new blame card for any coin, with live numbers from the chain:

```bash
npm run card -- 0xCOIN_ADDRESS
```

Re-render only the videos:

```bash
npm run video
```

Fetch fresh numbers for $AI, $MEME and $BONER and re-render everything:

```bash
npm run kit -- --refresh
```

Run the checks again:

```bash
npm run check
```

## Where the numbers come from

The blame cards use the site's own code (`site/src/data` and `site/src/core`) to read prices straight from
Robinhood Chain, so they match blamethestock.com exactly. If the chain can't be read, `npm run card` stops and says so;
it never makes numbers up. The OBSYN facts come from the chain recordings the site's tests already check.

## Licences

Video made with Remotion (free for individuals). Font: Archivo (SIL Open Font License). All artwork and sounds
were made from scratch for this kit.
