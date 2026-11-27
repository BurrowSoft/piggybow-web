// Builds the static site into dist/. No dependencies: Node's standard library only.
//
// Two modes:
// - production: only pages whose condition is met; placeholder "[DRAFT]" text stops the build.
// - preview (Vercel Preview, or SHOW_DRAFTS=1 locally): every page; gated ones carry a draft
//   banner; nothing is indexable.
// Anything that isn't explicitly a preview is built as production (fails closed).

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Slots the build fills with its own HTML. Templates may use {{{slot}}} only for these. */
export const RAW_SLOTS = Object.freeze([
  'banner',
  'canonicalTag',
  'content',
  'effectiveDate',
  'footerLinks',
  'header',
  'stores',
]);

/** Where a live store badge may link: the stores' own product pages. */
const STORE_URL = /^https:\/\/(?:apps\.apple\.com|play\.google\.com)\/[^\s"'<>]+$/;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A legal page's effective date. The config holds it as YYYY-MM-DD, the same string the app
 * records as the policy version; the page shows it in US English ("November 29, 2026").
 * Until it is set, the config holds a "[DRAFT] …" note, shown as is in previews. A production
 * build accepts only a real date: the build alone can't publish anything else.
 */
export function effectiveDateHtml(value, { production = false, where = 'policy' } = {}) {
  if (typeof value !== 'string') throw new Error(`${where}: no policy version`);
  if (!ISO_DATE.test(value)) {
    if (production) throw new Error(`${where}: production needs a real effective date (YYYY-MM-DD), not "${value}"`);
    return escapeHtml(value);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`not a real date: ${value}`);
  }
  const shown = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
  return `<time datetime="${value}">${escapeHtml(shown)}</time>`;
}

export function modeFromEnv(env = process.env) {
  if (env.SHOW_DRAFTS === '1') return 'preview';
  if (env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'development') return 'preview';
  return 'production';
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);

function lookup(vars, key) {
  if (own(vars, key)) return vars[key];
  let value = vars;
  for (const part of key.split('.')) {
    if (!own(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Fills {name} placeholders inside a text: `html` form in page bodies (e.g. a mailto link),
 * `text` form in titles and descriptions. An unknown placeholder is an error.
 */
export function fillTokens(value, tokens, form, where) {
  return value.replace(/\{(\w+)\}/g, (_, name) => {
    if (!own(tokens, name)) throw new Error(`${where}: unknown placeholder {${name}}`);
    return tokens[name][form];
  });
}

/**
 * Replaces {{key}} (escaped text from `vars`, placeholders filled) and {{{slot}}} (raw HTML, taken
 * only from `slots`, the build's own map, and only for RAW_SLOTS). The copy can never reach a raw slot.
 * A key with no text is an error, never an empty string.
 */
export function render(template, vars, where, track = () => {}, tokens = {}, slots = {}) {
  return template.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (_, raw, esc) => {
    if (raw) {
      if (!RAW_SLOTS.includes(raw)) throw new Error(`${where}: {{{${raw}}}} is not a build slot`);
      const html = own(slots, raw) ? slots[raw] : undefined;
      if (typeof html !== 'string') throw new Error(`${where}: no slot {{{${raw}}}} here`);
      return html;
    }
    const value = lookup(vars, esc);
    if (typeof value !== 'string') throw new Error(`${where}: no text for {{${esc}}}`);
    track(esc);
    return fillTokens(escapeHtml(value), tokens, 'html', `${where} ${esc}`);
  });
}

/**
 * The output folder is deleted before each build, so refuse anything that would take more than
 * the build's own output with it: the repo itself, any folder that contains it, any folder inside
 * the repo other than dist/, a drive root, or a suspiciously short name.
 */
export function assertSafeOutDir(root, outDir) {
  const same = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
  const out = path.resolve(outDir);
  const repo = path.resolve(root);
  const o = same(out);
  const r = same(repo);
  const withSep = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
  const insideRepo = o.startsWith(withSep(r));
  if (
    o === r ||
    r.startsWith(withSep(o)) ||
    (insideRepo && o !== same(path.join(repo, 'dist'))) ||
    out === path.parse(out).root ||
    path.basename(out).length < 3
  ) {
    throw new Error(`refusing to clear ${out}`);
  }
  return out;
}

export async function build({
  root = ROOT,
  outDir = path.join(root, 'dist'),
  mode = 'production',
  messages,
  now = new Date(),
  track = () => {},
  config: configOverride,
} = {}) {
  if (mode !== 'production' && mode !== 'preview') throw new Error(`unknown mode: ${mode}`);
  const config = configOverride ?? JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  const msgs =
    messages ??
    JSON.parse(await readFile(path.join(root, 'src', 'messages', `${config.defaultLocale}.json`), 'utf8'));
  const layout = await readFile(path.join(root, 'src', 'templates', 'layout.html'), 'utf8');
  const notFound = await readFile(path.join(root, 'src', 'templates', '404.html'), 'utf8');

  const isMet = (gate) => {
    if (!gate) return true;
    if (!own(config.conditions, gate)) throw new Error(`unknown condition: ${gate}`);
    return config.conditions[gate].met === true;
  };
  const pages = config.pages
    .map((page) => ({ ...page, draft: !isMet(page.gate) }))
    .filter((page) => mode === 'preview' || !page.draft);

  const email = escapeHtml(config.supportEmail);
  const tokens = {
    supportEmail: { text: config.supportEmail, html: `<a href="mailto:${email}">${email}</a>` },
  };
  /** A text for an attribute or a build slot: placeholders filled as plain text, escaped later. */
  const text = (key, where) => {
    const value = lookup(msgs, key);
    if (typeof value !== 'string') throw new Error(`${where}: no text for ${key}`);
    track(key);
    return fillTokens(value, tokens, 'text', `${where} ${key}`);
  };
  /** A page's path. It's escaped wherever it goes into HTML. */
  const href = (slug) => `/${slug}`;
  const base = {
    ...msgs,
    lang: config.defaultLocale,
    year: String(now.getUTCFullYear()),
  };
  const draw = (template, vars, where, slots = {}) => render(template, vars, where, track, tokens, slots);

  // "© year Company · Support · Privacy": a link appears only once its page is built.
  const footerLinks = pages
    .filter((page) => page.footer)
    .map(
      (page) =>
        `<span aria-hidden="true">·</span><a href="${escapeHtml(href(page.slug))}">${escapeHtml(text(`nav.${page.messages}`, 'footer'))}</a>`,
    )
    .join('');
  // The home page's own heading is the name, so only the other pages carry the header.
  const header = (slug) =>
    slug === '' ? '' : `<header class="site-header"><a class="brand" href="/">${escapeHtml(text('site.name', 'header'))}</a></header>`;

  // The home page's store badges, in config order (App Store first, as Apple's guidelines ask).
  // A store shows once its condition is met; previews show every store, with a labelled
  // placeholder until the official badge artwork and the link exist. While no store shows, the
  // "coming soon" line takes their place; once one shows, each store still to come gets its own
  // line ("Coming soon to iPhone.").
  const storeLinks = [];
  const soonKeys = [];
  for (const store of config.stores ?? []) {
    const live = isMet(store.gate);
    if (mode === 'production' && !live) {
      soonKeys.push(store.soon);
      continue;
    }
    const alt = text(store.label, 'stores');
    const badgeFile = path.join(root, 'src', 'assets', ...store.badge.split('/'));
    const hasBadge = existsSync(badgeFile);
    const hasUrl = typeof store.url === 'string' && STORE_URL.test(store.url);
    if (live && !hasUrl) throw new Error(`stores: ${store.id} is live but has no store page URL`);
    if (live && !hasBadge) throw new Error(`stores: ${store.id} is live but ${store.badge} is missing`);
    storeLinks.push(
      hasBadge && hasUrl
        ? `<a class="store" href="${escapeHtml(store.url)}"><img src="/assets/${escapeHtml(store.badge)}" alt="${escapeHtml(alt)}" height="48"></a>`
        : `<span class="store store-placeholder">${escapeHtml(alt)}</span>`,
    );
  }
  const soon = (key) => `<p class="soon">${escapeHtml(text(key, 'stores'))}</p>`;
  const stores = storeLinks.length
    ? `<p class="stores">${storeLinks.join('')}</p>${soonKeys.map(soon).join('')}`
    : soon('home.comingSoon');

  const finish = (html, where) => {
    if (mode === 'production' && html.includes('[DRAFT]')) {
      throw new Error(`${where}: placeholder [DRAFT] text can't go to production`);
    }
    return html;
  };

  const out = assertSafeOutDir(root, outDir);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  for (const page of pages) {
    const fragment = await readFile(path.join(root, 'src', 'pages', page.fragment), 'utf8');
    const html = draw(
      layout,
      {
        ...base,
        title: text(`${page.messages}.title`, page.fragment),
        description: text(`${page.messages}.description`, page.fragment),
        robots: mode === 'production' && !page.draft ? 'index, follow' : 'noindex, nofollow',
      },
      'layout.html',
      {
        canonicalTag: `<link rel="canonical" href="${escapeHtml(config.siteUrl + href(page.slug))}">`,
        banner: page.draft ? `<p class="draft-banner" role="note">${escapeHtml(text('draftBanner', page.fragment))}</p>` : '',
        header: header(page.slug),
        content: draw(
          fragment,
          base,
          page.fragment,
          {
            stores,
            ...(page.policy
              ? {
                  effectiveDate: effectiveDateHtml(config.policyVersions?.[page.policy], {
                    production: mode === 'production',
                    where: page.fragment,
                  }),
                }
              : {}),
          },
        ),
        footerLinks,
      },
    );
    await writeFile(path.join(out, `${page.slug || 'index'}.html`), finish(html, page.fragment));
  }

  const notFoundHtml = draw(
    layout,
    {
      ...base,
      title: text('notFound.title', '404.html'),
      description: text('notFound.lead', '404.html'),
      robots: 'noindex, nofollow',
    },
    'layout.html',
    {
      canonicalTag: '',
      banner: '',
      header: header('404'),
      content: draw(notFound, base, '404.html'),
      footerLinks,
    },
  );
  await writeFile(path.join(out, '404.html'), finish(notFoundHtml, '404.html'));

  if (mode === 'production') {
    await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
    const urls = pages.map((page) => `  <url><loc>${escapeHtml(config.siteUrl + href(page.slug))}</loc></url>`);
    await writeFile(
      path.join(out, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    );
  } else {
    await writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  }

  await cp(path.join(root, 'src', 'assets'), path.join(out, 'assets'), { recursive: true });

  return { mode, outDir: out, pages: pages.map((page) => ({ slug: page.slug, draft: page.draft })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build({ mode: modeFromEnv() }).then(
    (result) => {
      const list = result.pages.map((page) => `/${page.slug}${page.draft ? ' (draft)' : ''}`).join(', ');
      console.log(`Built ${result.mode}: ${list}`);
    },
    (error) => {
      console.error(`Build failed: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
