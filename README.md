# piggybow-web

The website for [piggybow.com](https://www.piggybow.com): the home page, support, and the legal pages the
app stores require. A BurrowSoft product.

It's a static site. There is no framework and nothing to install: a small Node script (standard library
only) turns the page fragments and the copy file into plain HTML in `dist/`, and Vercel serves that folder.
No scripts run in the browser, and the site loads nothing from other domains (no fonts, analytics or
tracking).

## Requirements

- Node.js 22 or newer.

## Commands

```bash
node scripts/build.mjs                  # production build into dist/
SHOW_DRAFTS=1 node scripts/build.mjs    # preview build: gated pages included as drafts
node --test test/build.test.mjs         # all checks (about a second)
```

To look at a build, open `dist/index.html` in a browser, or serve `dist/` with any static file server.

## How it fits together

| Path | What |
|---|---|
| `site.config.json` | The site URL, the support address, the page list, and the conditions that gate pages |
| `src/messages/en.json` | Every short text on the site (titles, descriptions, headings, labels) |
| `src/templates/layout.html` | The page shell: head, header, footer |
| `src/pages/*.html` | Each page's body. Long-form legal text is written here directly (legal pages are English only) |
| `src/assets/` | The stylesheet and the icon |
| `scripts/build.mjs` | The build |
| `test/build.test.mjs` | The checks |
| `vercel.json` | How Vercel builds and serves it, with the security headers |

In templates, `{{key}}` inserts a text from the copy file, HTML-escaped. A missing text stops the build:
it is never silently empty. `{{{slot}}}` inserts raw HTML and works only for the build's own slots.

## Pages and gates

| Path | Shown when |
|---|---|
| `/` | Always |
| `/support` | `support-mailbox-live` is met |
| `/privacy` | `privacy-text-approved` is met |
| `/terms` | `terms-text-approved` is met |
| `/404` | Always (served for unknown paths) |

**Text matches reality.** A page whose condition isn't met yet doesn't exist in production. It isn't
built, linked or listed in the sitemap. A preview build (Vercel Preview, or `SHOW_DRAFTS=1` locally) builds
it with a draft banner so it can be reviewed, and marks every page `noindex`. Anything that isn't explicitly
a preview builds as production, so a missing setting hides drafts instead of showing them.

Placeholder copy is marked `[DRAFT]`. A production build stops if any page it would publish still contains
that marker.

Turning a condition on is its own small change, made once what it describes is true. The tests pin the
current values.

## Languages

English is at `/`. More languages will follow the app's own, each at `/<locale>/`, with the same keys in
`src/messages/<locale>.json`. The legal pages stay in English.

## Deploy

Vercel builds every branch. Production comes from `master`; every other branch gets a Preview.
`vercel.json` sets the build command and output folder, which take precedence over the dashboard's
settings.
