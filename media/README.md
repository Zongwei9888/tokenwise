# TokenWise media kit

Everything here is rendered from the HTML in [`src/`](src) by headless Chromium, so any of it can be
changed and rebuilt. The "after" text and its numbers come from TokenWise itself: `src/gen-data.mts` runs the sample
pytest log through the real filter (260 lines → 17, 19.0 KB → 852 bytes).

## Files

| File | Size | Use it for |
|---|---|---|
| `images/social-preview.png` | 1280×640 | GitHub → Settings → Social preview; link cards on X, LinkedIn, Slack |
| `images/social-preview-zh.png` | 1280×640 | the same, Chinese (WeChat, Zhihu, Juejin, V2EX) |
| `images/banner.png`, `banner-zh.png` | 3200×1120 | top of a blog post or a launch page |
| `images/savings.png`, `-zh` | 2400 wide | the README's savings chart: per kind of work and model, from the paper's evaluation |
| `images/story-how.png`, `-zh` | 2400 wide | the README's overview: one layer, context on demand, self-evolving |
| `images/story-evolve.png`, `-zh` | 2400 wide | self-evolution in four steps (for posts and talks) |
| `images/before-after.png`, `-zh` | 3200×1800 | the one-image demo: same run, 17 lines instead of 260 |
| `images/icons/agent-*.png` | 128 px | the README's agent-wall badges for any shell and more agents |
| `video/tokenwise-en.mp4`, `-zh.mp4` | 1920×1080, 53 s | the explainer, in three chapters: context on demand, self-evolving, cross-platform |
| `video/fold.gif`, `fold-zh.gif` | 960 wide, 8 s | the fold, looping: README and chat where video does not play |

Images are rendered at 2× for sharp text on any screen.

## Icons

- **Flaticon.** Every pictogram is from Freepik's *Special Lineal* set on
  [Flaticon](https://www.flaticon.com/) (author shown there as Magnific), free with attribution.
  [`src/icons.json`](src/icons.json) lists each icon's page and the attribution line. The license does
  not allow passing on the icon files themselves, so they are not in this repository:
  `render.mjs` downloads them into `src/.icons/` (git-ignored) and they only appear inside the
  rendered images. Anything that uses those images credits Flaticon, as both READMEs do in their footer.
- **Agent logos** belong to their products. They come from [Lobe Icons](https://github.com/lobehub/lobe-icons)
  (MIT) and pi's own site; [`agents/NOTICE.md`](agents/NOTICE.md) and
  [`agents/sources.json`](agents/sources.json) list where each one is from.

## Rebuild

Needs Node 22, ffmpeg, network access for the first run (the Flaticon icons), and the Chromium that
`pnpm e2e` installs (Playwright's cache).

```sh
cd media/src
node --conditions=source gen-data.mts   # real filter output for the sample run
node render.mjs stills                  # every image (or: node render.mjs stills story-)
node render.mjs video en                # and: node render.mjs video zh
node render.mjs frames en 9,24,40       # preview single moments of the video
```

The GIFs are cut from the videos:

```sh
cd media/video
ffmpeg -ss 6.9 -t 7.6 -i tokenwise-en.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 fold.gif
```

## Look

| Token | Value | Role |
|---|---|---|
| Paper | `#EEF3F1` | ground |
| Ink | `#0E2A26` | text |
| Teal | `#0F766E` | brand |
| Mint | `#CCFBF1` | tint, notes in terminals |
| Terminal | `#0B3B36` | terminal ground |
| Kept | `#F2B705` | evidence that stays (the logo's bolt); only ever used for that |

Type: [Archivo](https://fonts.google.com/specimen/Archivo) for headlines, set narrow (width 64%): the
type is compressed the way the output is. [JetBrains Mono](https://www.jetbrains.com/lp/mono/) for
terminal text, with ligatures off so code reads as typed. Both are under the SIL Open Font License
(`src/fonts/`). The one motif is the fold: rows of output squeezing into a seam, with only the
evidence lit below it. Icons sit in teal or amber badges, never on their own.
