import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  assertSafeOutDir,
  build,
  effectiveDateHtml,
  escapeHtml,
  fillTokens,
  ISO_DATE,
  modeFromEnv,
  RAW_SLOTS,
  render,
  ROOT,
} from '../scripts/build.mjs';

const readJson = async (rel) => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
const config = await readJson('site.config.json');
const messages = await readJson('src/messages/en.json');
const vercel = await readJson('vercel.json');

// Stands in for approved copy: the same keys with every placeholder marker removed.
const approved = JSON.parse(JSON.stringify(messages).replaceAll('[DRAFT] ', 'Approved '));
const gatedOff = config.pages.filter((page) => page.gate && config.conditions[page.gate].met !== true);

const temps = [];
after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A stand-in App Store page for tests (the real one is set when the app is public). */
const TEST_APP_STORE_URL = 'https://apps.apple.com/app/id0000000000';

/** The config with the given conditions met (and the App Store test URL); [change] edits a store. */
const withLive = (ids, change = (s) => s) => ({
  ...config,
  stores: config.stores.map((s) => change({ ...s, url: s.id === 'app-store' ? TEST_APP_STORE_URL : s.url })),
  conditions: Object.fromEntries(
    Object.entries(config.conditions).map(([id, c]) => [id, { ...c, met: ids.includes(id) ? true : c.met }]),
  ),
});

/** A throwaway copy of the site's sources, with stand-in badge files (never in the repo). */
async function rootWithBadges(...files) {
  const root = await mkdtemp(path.join(tmpdir(), 'pb-root-'));
  temps.push(root);
  await cp(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'src', 'assets', 'badges'), { recursive: true });
  for (const f of files) await writeFile(path.join(root, 'src', 'assets', f), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}

/** A throwaway output folder, removed after the run. */
async function tmpOut() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pb-x-'));
  temps.push(dir);
  return path.join(dir, 'dist');
}

async function buildTo(mode, msgs, track) {
  const outDir = path.join(await mkdtemp(path.join(tmpdir(), 'pb-site-')), 'dist');
  temps.push(path.dirname(outDir));
  const result = await build({ outDir, mode, messages: msgs, track });
  return { outDir, result };
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    }),
  );
  return nested.flat();
}

async function htmlFiles(outDir) {
  const files = (await listFiles(outDir)).filter((file) => file.endsWith('.html'));
  return Promise.all(files.map(async (file) => ({ file, html: await readFile(path.join(outDir, file), 'utf8') })));
}

const attrs = (html) => [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);

/** What a clean-URL request serves (Vercel cleanUrls): /x → x.html, / → index.html, files as is. */
function servedFile(url) {
  const clean = url.split('#')[0].split('?')[0];
  if (clean === '/') return 'index.html';
  const rel = clean.slice(1);
  return path.extname(rel) ? rel : `${rel}.html`;
}

describe('mode', () => {
  test('anything not explicitly a preview builds as production (fails closed)', () => {
    assert.equal(modeFromEnv({}), 'production');
    assert.equal(modeFromEnv({ VERCEL_ENV: 'production' }), 'production');
    assert.equal(modeFromEnv({ VERCEL_ENV: 'staging' }), 'production');
    assert.equal(modeFromEnv({ SHOW_DRAFTS: 'true' }), 'production');
    assert.equal(modeFromEnv({ VERCEL_ENV: 'preview' }), 'preview');
    assert.equal(modeFromEnv({ VERCEL_ENV: 'development' }), 'preview');
    assert.equal(modeFromEnv({ SHOW_DRAFTS: '1' }), 'preview');
  });

  test('an unknown mode is refused', async () => {
    await assert.rejects(build({ outDir: path.join(tmpdir(), 'pb-never'), mode: 'staging' }), /unknown mode/);
  });
});

describe('production', async () => {
  const { outDir } = await buildTo('production', approved);
  const files = await listFiles(outDir);
  const pages = await htmlFiles(outDir);

  test('every gated page whose condition is unmet is absent, unlinked and out of the sitemap', async () => {
    const sitemap = await readFile(path.join(outDir, 'sitemap.xml'), 'utf8');
    for (const page of gatedOff) {
      assert.ok(!files.includes(`${page.slug}.html`), `${page.slug}.html must not be built`);
      assert.ok(!sitemap.includes(`/${page.slug}<`), `${page.slug} must not be in the sitemap`);
      for (const { file, html } of pages) {
        assert.ok(!attrs(html).includes(`/${page.slug}`), `${file} must not link to /${page.slug}`);
      }
    }
  });

  test('the home page and the 404 page are always built', () => {
    assert.ok(files.includes('index.html'));
    assert.ok(files.includes('404.html'));
  });

  test('pages are indexable, except 404', () => {
    for (const { file, html } of pages) {
      const expected = file === '404.html' ? 'noindex, nofollow' : 'index, follow';
      assert.match(html, new RegExp(`<meta name="robots" content="${expected}">`), file);
      assert.ok(!html.includes('draft-banner'), `${file} has no draft banner`);
    }
  });

  test('robots.txt allows crawling and points at the sitemap', async () => {
    const robots = await readFile(path.join(outDir, 'robots.txt'), 'utf8');
    assert.match(robots, /^Allow: \/$/m);
    assert.ok(robots.includes(`Sitemap: ${config.siteUrl}/sitemap.xml`));
  });

  test('placeholder [DRAFT] text stops the build', async () => {
    const draftHome = structuredClone(approved);
    draftHome.home.headline = '[DRAFT] not yet approved';
    await assert.rejects(buildTo('production', draftHome), /\[DRAFT\]/);
  });

  test('the real copy builds for production: what is live has final text, the rest is gated off', async () => {
    const { outDir: real, result } = await buildTo('production', messages);
    const live = config.pages.filter((p) => !p.gate || config.conditions[p.gate].met === true).map((p) => p.slug);
    assert.deepEqual(result.pages.map((p) => p.slug), live);
    // A live page never links one that is still gated off (it would 404):
    // /x, /x/, /x.html, /x#part, /x?q and the site's own absolute URLs alike.
    // Files (/styles.css, /badges/….svg) aren't pages.
    const built = new Set(result.pages.map((p) => `/${p.slug}`));
    for (const { file, html } of await htmlFiles(real)) {
      assert.ok(!html.includes('[DRAFT]'), file);
      for (const [, raw] of html.matchAll(/href="([^"]*)"/g)) {
        const local = raw.startsWith(config.siteUrl) ? raw.slice(config.siteUrl.length) || '/' : raw;
        if (!local.startsWith('/') || local.startsWith('//')) continue;
        const where = local.split(/[?#]/)[0];
        if (/\.(?!html$)[a-z0-9]+$/i.test(where)) continue;
        const page = where.replace(/\.html$/, '').replace(/(.)\/$/, '$1');
        assert.ok(built.has(page), `${file} links ${raw}, which isn't built`);
      }
    }
  });

  test('Help says what happens to an email, and that your journal is never stored with us', async () => {
    const { outDir } = await buildTo('production', messages);
    const html = await readFile(path.join(outDir, 'support.html'), 'utf8');
    const email = config.supportEmail;
    for (const needed of [
      'If you email us, we get your email address and your message and use them only to reply.',
      `Emails to <a href="mailto:${email}">${email}</a> are passed on to our mailbox by Forward Email, an email-forwarding service.`,
      'Your journal is never stored with us.',
    ]) {
      assert.ok(html.includes(needed), needed);
    }
  });
});

describe('preview', async () => {
  const { outDir } = await buildTo('preview', messages);
  const files = await listFiles(outDir);
  const pages = await htmlFiles(outDir);

  test('gated pages are built as drafts with a banner', async () => {
    for (const page of gatedOff) {
      const html = await readFile(path.join(outDir, `${page.slug}.html`), 'utf8');
      assert.ok(html.includes('class="draft-banner"'), `${page.slug} shows the draft banner`);
    }
  });

  test('nothing is indexable: noindex everywhere, robots disallows all, no sitemap', async () => {
    for (const { file, html } of pages) {
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/, file);
    }
    assert.equal(await readFile(path.join(outDir, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
    assert.ok(!files.includes('sitemap.xml'));
  });
});

describe('every built page', async () => {
  const builds = [await buildTo('production', approved), await buildTo('preview', messages)];

  test('is a complete document with no unfilled slot', async () => {
    for (const { outDir, result } of builds) {
      for (const { file, html } of await htmlFiles(outDir)) {
        const where = `${result.mode}/${file}`;
        assert.ok(html.startsWith('<!doctype html>'), where);
        assert.match(html, /<html lang="en">/, where);
        assert.match(html, /<meta charset="utf-8">/, where);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, where);
        assert.match(html, /<title>[^<]+<\/title>/, where);
        assert.match(html, /<meta name="description" content="[^"]+">/, where);
        assert.match(html, /<link rel="stylesheet" href="\/assets\/site.css">/, where);
        assert.match(html, /<h1>[^<]+<\/h1>/, where);
        assert.ok(!html.includes('{{') && !html.includes('}}'), `${where} has an unfilled slot`);
      }
    }
  });

  test('links and assets resolve to built files', async () => {
    for (const { outDir, result } of builds) {
      const files = await listFiles(outDir);
      for (const { file, html } of await htmlFiles(outDir)) {
        for (const url of attrs(html).filter((u) => u.startsWith('/'))) {
          assert.ok(files.includes(servedFile(url)), `${result.mode}/${file} links to ${url}, which isn't built`);
        }
      }
    }
  });

  test('makes no third-party request: only own paths, mailto and the canonical URL', async () => {
    for (const { outDir, result } of builds) {
      for (const { file, html } of await htmlFiles(outDir)) {
        for (const url of attrs(html)) {
          const storePage = (config.stores ?? []).some((s) => s.url === url);
          const ok = url.startsWith('/') || url.startsWith('mailto:') || url.startsWith(`${config.siteUrl}/`) || storePage;
          assert.ok(ok, `${result.mode}/${file} references ${url}`);
        }
        assert.ok(!/<script\b/i.test(html), `${result.mode}/${file} has no script`);
      }
    }
    const css = await readFile(path.join(ROOT, 'src', 'assets', 'site.css'), 'utf8');
    assert.ok(!/url\(|@import|https?:/i.test(css), 'site.css loads nothing from elsewhere');
  });

  test('canonical URLs use the site URL', async () => {
    const { outDir } = builds[0];
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(home.includes(`<link rel="canonical" href="${config.siteUrl}/">`));
  });

  test('the home page carries no header (its heading is the name); the others link home', async () => {
    for (const { outDir, result } of builds) {
      for (const { file, html } of await htmlFiles(outDir)) {
        const hasHeader = html.includes('<header class="site-header"><a class="brand" href="/">Piggybow</a></header>');
        assert.equal(hasHeader, file !== 'index.html', `${result.mode}/${file}`);
      }
    }
  });

  test('the footer is "© year BurrowSoft", then a link per page that is built', async () => {
    const year = new Date().getUTCFullYear();
    for (const { outDir, result } of builds) {
      const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
      const line = home.match(/<p class="footer-line">(.*?)<\/p>/s)?.[1] ?? '';
      assert.ok(line.startsWith(`<span>© ${year} BurrowSoft</span>`), result.mode);
      const linked = [...line.matchAll(/<a href="\/([\w-]+)">/g)].map((m) => m[1]);
      const built = result.pages.filter((p) => config.pages.find((c) => c.slug === p.slug).footer).map((p) => p.slug);
      assert.deepEqual(linked, built, result.mode);
    }
  });
});

describe('copy', () => {
  test('the support address is a mail link in the page and plain text in the description', async () => {
    const { outDir } = await buildTo('preview', messages);
    const html = await readFile(path.join(outDir, 'support.html'), 'utf8');
    const email = config.supportEmail;
    const link = `<a href="mailto:${email}">${email}</a>`;
    assert.ok(
      html.includes(
        `<p class="lead">Write to us at ${link}. We read every message. If you email us, we get your email address and ` +
          `your message and use them only to reply. Emails to ${link} are passed on to our mailbox by Forward Email, ` +
          'an email-forwarding service.</p>',
      ),
    );
    assert.ok(html.includes(`<meta name="description" content="Write to us at ${email}. We read every message.">`));
  });

  test('an unknown placeholder is an error', () => {
    assert.throws(() => fillTokens('Hi {nope}', {}, 'html', 'test'), /unknown placeholder \{nope\}/);
    assert.throws(() => render('{{a}}', { a: 'Hi {nope}' }, 'test'), /unknown placeholder/);
  });

  test('no guilt words in any text (the product rule for every screen)', () => {
    const banned = /\b(over budget|behind|missed|failed|you should)\b/i;
    for (const value of JSON.stringify(messages).match(/"(?:[^"\\]|\\.)*"/g)) {
      assert.ok(!banned.test(value), `${value} breaks the no-guilt rule`);
    }
  });
});

describe('text', () => {
  test('a missing text is an error, never an empty string', () => {
    assert.throws(() => render('<p>{{home.nope}}</p>', messages, 'test'), /no text for \{\{home\.nope\}\}/);
    assert.throws(() => render('<p>{{home}}</p>', messages, 'test'), /no text/);
  });

  test('text is escaped; raw HTML only goes into the build slots', () => {
    assert.equal(render('{{a}}', { a: `<b> & "q" 'q'` }, 'test'), '&lt;b&gt; &amp; &quot;q&quot; &#39;q&#39;');
    assert.equal(escapeHtml('a&b'), 'a&amp;b');
    assert.throws(() => render('{{{home.lead}}}', messages, 'test'), /not a build slot/);
  });

  test('raw slots come only from the build\'s own map, never from the copy', () => {
    const copyWithSlotNames = { content: '<script>x</script>', header: '<b>' };
    assert.throws(() => render('{{{content}}}', copyWithSlotNames, 'test'), /no slot \{\{\{content\}\}\}/);
    assert.equal(render('{{{content}}}', copyWithSlotNames, 'test', undefined, {}, { content: '<p>ok</p>' }), '<p>ok</p>');
    // As text, a copy key with a slot's name is still just escaped text.
    assert.equal(render('{{header}}', copyWithSlotNames, 'test'), '&lt;b&gt;');
  });

  test('templates and pages use raw slots only for the build slots', async () => {
    const dirs = ['src/templates', 'src/pages'];
    for (const dir of dirs) {
      for (const file of await readdir(path.join(ROOT, dir))) {
        const source = await readFile(path.join(ROOT, dir, file), 'utf8');
        for (const [, key] of source.matchAll(/\{\{\{\s*([\w.]+)\s*\}\}\}/g)) {
          assert.ok(RAW_SLOTS.includes(key), `${dir}/${file} uses {{{${key}}}}`);
        }
      }
    }
  });

  test('every message is used on some page (no stale copy)', async () => {
    const used = new Set();
    // Production and preview together: some text shows in only one of them (e.g. "coming soon").
    await buildTo('preview', messages, (key) => used.add(key));
    await buildTo('production', approved, (key) => used.add(key));
    // And the partial launches, where each store's "coming soon" line shows.
    for (const [badges, live] of [
      [['badges/google-play.svg'], ['android-store-live']],
      [['badges/app-store.svg'], ['ios-store-live']],
    ]) {
      const root = await rootWithBadges(...badges);
      const outDir = path.join(root, 'dist');
      await build({ root, outDir, mode: 'production', messages: approved, config: withLive(live), track: (key) => used.add(key) });
    }
    const leaves = (obj, prefix = '') =>
      Object.entries(obj).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : leaves(v, `${prefix}${k}.`)));
    for (const key of leaves(messages)) assert.ok(used.has(key), `${key} is never used`);
  });
});

describe('legal pages', () => {
  test('the effective date shows in US English and keeps the exact version string', () => {
    assert.equal(effectiveDateHtml('2026-11-29'), '<time datetime="2026-11-29">November 29, 2026</time>');
    assert.throws(() => effectiveDateHtml('2026-02-30'), /not a real date/);
    assert.throws(() => effectiveDateHtml(undefined), /no policy version/);
    assert.equal(effectiveDateHtml('[DRAFT] <later>'), '[DRAFT] &lt;later&gt;');
  });

  test('a production build accepts only a real effective date', () => {
    const production = { production: true, where: 'privacy.html' };
    assert.equal(effectiveDateHtml('2026-11-29', production), '<time datetime="2026-11-29">November 29, 2026</time>');
    for (const bad of ['[DRAFT] later', '2026/11/29', '', 'November 29, 2026']) {
      assert.throws(() => effectiveDateHtml(bad, production), /production needs a real effective date/, JSON.stringify(bad));
    }
    assert.throws(() => effectiveDateHtml('2026-02-30', production), /not a real date/);
  });

  test('a policy version is a real date, or a [DRAFT] note while the page is gated off', () => {
    for (const page of config.pages.filter((p) => p.policy)) {
      const version = config.policyVersions[page.policy];
      assert.ok(ISO_DATE.test(version) || version.startsWith('[DRAFT]'), `${page.policy}: ${version}`);
      if (config.conditions[page.gate]?.met === true) {
        assert.match(version, ISO_DATE, `${page.slug} is live, so it needs its effective date`);
      }
    }
  });

  test('the privacy policy has the outline\'s nine sections, in order', async () => {
    const { outDir } = await buildTo('preview', messages);
    const html = await readFile(path.join(outDir, 'privacy.html'), 'utf8');
    const ids = [...html.matchAll(/<section id="([\w-]+)">/g)].map((m) => m[1]);
    assert.deepEqual(ids, [
      'who-we-are',
      'what-the-app-stores',
      'what-leaves-your-phone',
      'no-ads-or-tracking',
      'children',
      'your-choices',
      'changes',
      'contact',
      'effective-date',
    ]);
    assert.ok(html.includes(`<a href="mailto:${config.supportEmail}">`), 'the contact section links the support address');
  });

  // Pig tips (decision 94): each claim as the app and the tips server do it.
  test('the privacy policy and Help say what pig tips send, to whom, and for how long', async () => {
    const { outDir } = await buildTo('production', messages);
    const privacy = await readFile(path.join(outDir, 'privacy.html'), 'utf8');
    for (const line of [
      'Your journal doesn&#39;t. Piggybow has no account and no server for your money notes.',
      '<strong>Pig tips, only if you turn them on.</strong>',
      'It never sends your notes, amounts, dates, goal names or anything you typed.',
      'Anthropic doesn&#39;t use it to train AI models and deletes it within 30 days',
      'for 90 days to improve our filter',
      'Our server keeps a random app ID, the IP address it last connected from, and a count of tips per day',
      'The counts are deleted after 30 days, and the ID with its IP address after 30 days without tips.',
      'Supabase&#39;s logs also keep the IP address for up to 7 days',
      'Turn tips off in Me → Pig tips, or use Delete all my data, and we delete that ID, its IP address and its count as soon as your phone is online.',
      'the European Commission&#39;s Standard Contractual Clauses',
      '<strong>Pig tips</strong> stay off until you say yes',
    ]) {
      assert.ok(privacy.includes(line), line);
    }
    const support = await readFile(path.join(outDir, 'support.html'), 'utf8');
    assert.ok(support.includes('What are pig tips, and what do they send?'));
    assert.ok(support.includes('Never your notes, amounts or anything you typed.'));
    assert.ok(support.includes('If you turned on pig tips, it also deletes the random ID, its IP address and the daily count our server keeps for them.'));
  });

  test('the privacy policy is live: its effective date, and what an email to us gives us', async () => {
    const { outDir } = await buildTo('production', messages);
    const html = await readFile(path.join(outDir, 'privacy.html'), 'utf8');
    assert.match(config.policyVersions.privacy, ISO_DATE);
    assert.ok(html.includes(`<time datetime="${config.policyVersions.privacy}">`), 'the effective date');
    assert.ok(html.includes('If you email us, we get your email address and your message and use them only to reply.'));
    assert.ok(html.includes('are passed on to our mailbox by Forward Email, an email-forwarding service.'));
    assert.ok(!html.includes('draft-banner'));
  });
});

describe('config', () => {
  test('every gate names a known condition, and every condition says what it means', () => {
    for (const page of config.pages.filter((p) => p.gate)) {
      assert.ok(Object.hasOwn(config.conditions, page.gate), `${page.slug}: unknown gate ${page.gate}`);
    }
    for (const [id, condition] of Object.entries(config.conditions)) {
      assert.equal(typeof condition.met, 'boolean', id);
      assert.ok(condition.what.length > 20, `${id} explains itself`);
    }
  });

  test('the conditions are pinned: flipping one is its own reviewed change', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(config.conditions).map(([id, c]) => [id, c.met])),
      {
        'support-mailbox-live': true,
        'privacy-text-approved': true,
        'terms-text-approved': false,
        'ios-store-live': false,
        'android-store-live': false,
      },
    );
  });

  test('the app links to these paths: /privacy, /terms, /support stay where they are', () => {
    const slugs = config.pages.map((page) => page.slug);
    for (const slug of ['', 'privacy', 'terms', 'support']) assert.ok(slugs.includes(slug), `/${slug}`);
  });

  test('the output folder can never be the repo, a folder that holds it, a drive root, or anything in the repo but dist/', () => {
    const repo = ROOT;
    const refused = [
      repo,
      path.dirname(repo),
      path.dirname(path.dirname(repo)),
      path.parse(repo).root,
      path.join(repo, 'x'),
      path.join(repo, 'src'),
      path.join(repo, 'test'),
      path.join(repo, 'dist', 'pages'),
      path.join(repo, 'src', 'dist'),
    ];
    if (process.platform === 'win32') {
      refused.push(repo.toUpperCase(), path.dirname(repo).toLowerCase(), path.join(repo, 'SRC'));
      assert.equal(assertSafeOutDir(repo, path.join(repo, 'DIST')), path.join(repo, 'DIST'), 'dist/ in any case on Windows');
    }
    for (const dir of refused) assert.throws(() => assertSafeOutDir(repo, dir), /refusing to clear/, dir);
    assert.equal(assertSafeOutDir(repo, path.join(repo, 'dist')), path.join(repo, 'dist'));
    const elsewhere = path.join(tmpdir(), 'pb-site-out', 'dist');
    assert.equal(assertSafeOutDir(repo, elsewhere), path.resolve(elsewhere));
    // A sibling whose name merely starts with the repo's folder name is not an ancestor.
    const sibling = `${repo}-out`;
    assert.equal(assertSafeOutDir(repo, sibling), path.resolve(sibling));
  });

  test('CI pins every action to a commit sha', async () => {
    const ci = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yaml'), 'utf8');
    const uses = [...ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length >= 2, 'the workflow uses actions');
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
  });

  test('vercel.json serves this build with clean URLs and strict headers', () => {
    assert.equal(vercel.framework, null);
    assert.equal(vercel.buildCommand, 'node scripts/build.mjs');
    assert.equal(vercel.outputDirectory, 'dist');
    assert.equal(vercel.cleanUrls, true);
    assert.equal(vercel.trailingSlash, false);
    const all = vercel.headers.find((h) => h.source === '/(.*)');
    const get = (name) => all.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value ?? '';
    const csp = get('Content-Security-Policy');
    for (const part of ["default-src 'none'", "style-src 'self'", "img-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
      assert.ok(csp.includes(part), `CSP has ${part}`);
    }
    assert.equal(get('X-Content-Type-Options'), 'nosniff');
    assert.equal(get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });
});

describe('store badges', () => {
  const play = config.stores.find((s) => s.id === 'google-play');
  const badge = (id, url, file, alt) =>
    `<a class="store" href="${url}"><img src="/assets/badges/${file}" alt="${alt}" height="48"></a>`;

  test('config: App Store first; each store names a known gate, copy keys and a badge under badges/', () => {
    assert.deepEqual(config.stores.map((s) => s.id), ['app-store', 'google-play']);
    for (const s of config.stores) {
      assert.ok(Object.hasOwn(config.conditions, s.gate), s.id);
      assert.ok(s.badge.startsWith('badges/') && s.badge.endsWith('.svg'), s.id);
      for (const ref of [s.label, s.soon]) {
        const [ns, key] = ref.split('.');
        assert.equal(typeof messages[ns][key], 'string', ref);
      }
      if (s.url !== null) assert.match(s.url, /^https:\/\/(?:apps\.apple\.com|play\.google\.com)\//, s.id);
    }
    assert.equal(play.url, 'https://play.google.com/store/apps/details?id=com.burrowsoft.piggybow');
  });

  test('iPhone first: the App Store badge, then "Coming soon to Android."', async () => {
    const root = await rootWithBadges('badges/app-store.svg');
    const outDir = path.join(root, 'dist');
    await build({ root, outDir, mode: 'production', messages: approved, config: withLive(['ios-store-live']) });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(
      home.includes(
        `<p class="stores">${badge('app-store', TEST_APP_STORE_URL, 'app-store.svg', messages.home.badgeAppStore)}</p>` +
          `<p class="soon">${messages.home.soonAndroid}</p>`,
      ),
    );
    assert.ok(!home.includes(messages.home.comingSoon));
  });

  test('both live: the two badges, App Store first, and no "coming soon" line', async () => {
    const root = await rootWithBadges('badges/app-store.svg', 'badges/google-play.svg');
    const outDir = path.join(root, 'dist');
    await build({ root, outDir, mode: 'production', messages: approved, config: withLive(['ios-store-live', 'android-store-live']) });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(
      home.includes(
        `<p class="stores">${badge('app-store', TEST_APP_STORE_URL, 'app-store.svg', messages.home.badgeAppStore)}` +
          `${badge('google-play', play.url, 'google-play.svg', messages.home.badgeGooglePlay)}</p>`,
      ),
    );
    assert.ok(!home.includes('class="soon"'));
  });

  test('production with no store live: the "coming soon" line, no badges', async () => {
    const { outDir } = await buildTo('production', approved);
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(home.includes(`<p class="soon">${messages.home.comingSoon}</p>`));
    assert.ok(!home.includes('class="stores"'));
  });

  test('preview: every store, as placeholders until the official artwork is added', async () => {
    const { outDir } = await buildTo('preview', messages);
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    const placeholders = [...home.matchAll(/<span class="store store-placeholder">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(placeholders, [messages.home.badgeAppStore, messages.home.badgeGooglePlay]);
    assert.ok(!home.includes('class="soon"'));
  });

  test('Android first: the Play badge links to the store page, then "Coming soon to iPhone."', async () => {
    const root = await rootWithBadges('badges/google-play.svg');
    const outDir = path.join(root, 'dist');
    await build({ root, outDir, mode: 'production', messages: approved, config: withLive(['android-store-live']) });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(
      home.includes(
        `<p class="stores">${badge('google-play', play.url, 'google-play.svg', messages.home.badgeGooglePlay)}</p>` +
          `<p class="soon">${messages.home.soonIphone}</p>`,
      ),
    );
    assert.ok(!home.includes(messages.home.comingSoon));
    assert.ok(!home.includes('app-store'), 'the App Store badge waits for its own condition');
    assert.ok((await readdir(path.join(outDir, 'assets', 'badges'))).includes('google-play.svg'));
  });

  test('a badge path must be one plain name in badges/, in every mode', async () => {
    for (const bad of ['../evil.svg', 'badges/../../x.svg', 'badges/sub/x.svg', '/etc/x.svg', 'badges/x.png', 'badges/X Y.svg']) {
      const cfg = { ...config, stores: config.stores.map((s) => (s.id === 'google-play' ? { ...s, badge: bad } : s)) };
      for (const mode of ['preview', 'production']) {
        const live = mode === 'production' ? withLive(['android-store-live'], (s) => (s.id === 'google-play' ? { ...s, badge: bad } : s)) : cfg;
        await assert.rejects(
          build({ outDir: await tmpOut(), mode, messages: approved, config: live }),
          /isn't badges\/<name>\.svg/,
          `${mode} ${bad}`,
        );
      }
    }
  });

  test('a live store needs its official badge file, a store page URL, and final text', async () => {
    const live = withLive(['android-store-live']);
    await assert.rejects(
      build({ outDir: await tmpOut(), mode: 'production', messages: approved, config: live }),
      /google-play is live but badges\/google-play\.svg is missing/,
    );
    const root = await rootWithBadges('badges/google-play.svg', 'badges/app-store.svg');
    await assert.rejects(
      build({
        root,
        outDir: path.join(root, 'dist'),
        mode: 'production',
        messages: approved,
        config: withLive(['ios-store-live'], (s) => (s.id === 'app-store' ? { ...s, url: null } : s)),
      }),
      /app-store is live but has no store page URL/,
    );
    await assert.rejects(
      build({
        root,
        outDir: path.join(root, 'dist'),
        mode: 'production',
        messages: approved,
        config: withLive(['android-store-live'], (s) => (s.id === 'google-play' ? { ...s, url: 'https://example.com/piggybow' } : s)),
      }),
      /no store page URL/,
    );
    await assert.rejects(
      build({
        root,
        outDir: path.join(root, 'dist'),
        mode: 'production',
        messages: { ...approved, home: { ...approved.home, badgeGooglePlay: '[DRAFT] not final' } },
        config: live,
      }),
      /\[DRAFT\]/,
    );
  });
});

describe('assets', () => {
  test('every SVG is plain shapes: no script, link, embedded image, style or external URL', async () => {
    const dir = path.join(ROOT, 'src', 'assets');
    const svgs = (await readdir(dir)).filter((f) => f.endsWith('.svg'));
    assert.ok(svgs.length >= 2, 'favicon and pig');
    for (const file of svgs) {
      const svg = await readFile(path.join(dir, file), 'utf8');
      const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
      assert.ok(!/<(script|a|image|foreignObject|use|style|iframe)\b|\bon\w+=|href=|url\(|https?:/i.test(withoutNamespace), file);
      assert.match(svg, /<title>Piggybow<\/title>/, `${file} carries a plain title`);
    }
  });

  test('the home page shows the happy pig as decoration, with a fixed size (no layout shift)', async () => {
    const { outDir } = await buildTo('production', messages);
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(home.includes('<img class="pig" src="/assets/pig-happy.svg" alt="" width="200" height="200">'));
    assert.ok(home.indexOf('class="pig"') < home.indexOf('<h1>'), 'the pig sits above the heading');
  });
});

test('no leftovers from the app this was modelled on', async () => {
  const banned = new RegExp(['mood', 'bow'].join(''), 'i');
  const skip = new Set(['.git', 'node_modules', 'dist']);
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else assert.ok(!banned.test(await readFile(full, 'utf8')), `${path.relative(ROOT, full)} mentions it`);
    }
  };
  await walk(ROOT);
});

describe('no hidden characters (decision 37)', () => {
  // Built from code points, so this file itself contains none of them.
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const BANNED = new Set([
    ...range(0x202a, 0x202e), // bidi embeddings and overrides
    ...range(0x2066, 0x2069), // bidi isolates
    ...range(0x200b, 0x200d), // zero-width space, non-joiner, joiner
    0x2060, // word joiner
    0xfeff, // zero-width no-break space / BOM
    0x00a0, // no-break space
    0x202f, // narrow no-break space
    0x200e, // left-to-right mark
    0x200f, // right-to-left mark
    0x061c, // Arabic letter mark
    0x2028, // line separator
    0x2029, // paragraph separator
    0x00ad, // soft hyphen
  ]);
  // Translation files may hold these, listed one by one: no-break spaces (fr, de) and Thai breaks.
  const TRANSLATION_ALLOWED = new Set([0x00a0, 0x202f, 0x200b]);
  const isTranslation = (rel) => /^src\/messages\/[^/]+\.json$/.test(rel);
  const TEXT = /\.(mjs|js|json|html|css|md|ya?ml|svg|txt)$|^\.git(attributes|ignore)$/;

  const hidden = (text, allowed) =>
    [...text].map((ch) => ch.codePointAt(0)).filter((cp) => BANNED.has(cp) && !allowed.has(cp));

  test('no source, config, workflow or doc file holds a bidi control or an invisible character', async () => {
    const skip = new Set(['.git', 'node_modules', 'dist']);
    const found = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (!TEXT.test(entry.name)) continue;
        const bad = hidden(await readFile(full, 'utf8'), isTranslation(rel) ? TRANSLATION_ALLOWED : new Set());
        if (bad.length) found.push(`${rel}: ${[...new Set(bad)].map((cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')).join(' ')}`);
      }
    };
    await walk(ROOT);
    assert.deepEqual(found, []);
  });

  test('the check catches each banned character, and allows only the listed ones in translations (control)', () => {
    for (const cp of BANNED) {
      const sample = `a${String.fromCodePoint(cp)}b`;
      assert.equal(hidden(sample, new Set()).length, 1, cp.toString(16));
      assert.equal(hidden(sample, TRANSLATION_ALLOWED).length, TRANSLATION_ALLOWED.has(cp) ? 0 : 1, cp.toString(16));
    }
    assert.ok(isTranslation('src/messages/fr.json'));
    assert.ok(!isTranslation('src/pages/index.html'));
    assert.deepEqual(hidden('plain text, "quotes" and – dashes · dots', new Set()), []);
  });
});
