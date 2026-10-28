// Independent final-state verifiers: historical v1 wrappers and explicit v2 tasks.
//
// These intentionally do not read the engine result. They wait (bounded) for the page,
// then check the exact origin/path plus task-specific DOM markers. A URL match alone is
// not enough, so an engine that stops at the right URL before the page is usable is a
// false success.

async function readFinalPage(page, evaluateFn) {
  let loadError = null;
  try {
    if (typeof page.waitForLoadState === 'function') {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    }
  } catch (err) {
    loadError = String(err?.message || err);
  }
  let url = null;
  let title = null;
  let dom = null;
  try {
    url = await page.url();
  } catch (err) {
    loadError = loadError ?? `url() failed: ${String(err?.message || err)}`;
  }
  try {
    if (typeof page.title === 'function') title = await page.title();
  } catch {
    title = null;
  }
  try {
    dom = await page.evaluate(evaluateFn);
  } catch (err) {
    dom = { error: String(err?.message || err) };
  }
  return { url, title, dom, loadError };
}

function parsedUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function conditionSignals(dom) {
  const hasPassword = dom?.passwordInput === true;
  const hasCaptcha = dom?.captchaMarker === true;
  const hasRegion = dom?.regionBlockMarker === true;
  return {
    passwordInput: hasPassword,
    captchaMarker: hasCaptcha,
    regionBlockMarker: hasRegion,
    caveat: 'true = marker observed in the final DOM; false does not prove absence',
  };
}

function hnDomProbe() {
  const bodyText = String(document.body?.innerText || '');
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');
  return {
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    title: document.title,
    hnMain: Boolean(document.querySelector('#hnmain')),
    commentTree: Boolean(document.querySelector('.comment-tree')),
    commentRows: document.querySelectorAll('.comment-tree tr.athing, tr.comtr, .comment').length,
    commentBodies: [...document.querySelectorAll('.comment')].filter((node) => String(node.textContent || '').trim()).length,
    storyRows: document.querySelectorAll('tr.athing').length,
    storyTitles: [...document.querySelectorAll('.titleline > a[href]')].filter((node) => String(node.textContent || '').trim()).length,
    selectedPaths: [...document.querySelectorAll('.pagetop .topsel a[href]')].map((a) => {
      try { return new URL(a.getAttribute('href'), location.href).pathname; } catch { return null; }
    }),
    itemLinks: links.filter((href) => /^item\?id=\d+/.test(href)).length,
    passwordInput: Boolean(document.querySelector('input[type="password"]')),
    captchaMarker: Boolean(document.querySelector('iframe[src*="captcha"], .g-recaptcha, [id*="captcha"], [class*="captcha"]')),
    regionBlockMarker: /not available in your region|blocked in your region|geo.?block/i.test(bodyText),
    textSample: bodyText.slice(0, 240),
  };
}

function wikiDomProbe() {
  const bodyText = String(document.body?.innerText || '');
  const heading = document.querySelector('#firstHeading');
  const content = document.querySelector('#mw-content-text');
  const paragraphs = content
    ? [...content.querySelectorAll('p')].map((p) => String(p.textContent || '').trim()).filter(Boolean)
    : [];
  return {
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    title: document.title,
    heading: heading ? String(heading.textContent || '').trim() : null,
    content: Boolean(content),
    paragraphCount: paragraphs.length,
    longParagraphs: paragraphs.filter((text) => text.length >= 100).length,
    passwordInput: Boolean(document.querySelector('input[type="password"]')),
    captchaMarker: Boolean(document.querySelector('iframe[src*="captcha"], .g-recaptcha, [id*="captcha"], [class*="captcha"]')),
    regionBlockMarker: /not available in your region|blocked in your region|geo.?block/i.test(bodyText),
    textSample: paragraphs[0]?.slice(0, 240) ?? '',
  };
}

export async function verifyHackerNews(page) {
  const final = await readFinalPage(page, hnDomProbe);
  const url = parsedUrl(final.url);
  const dom = final.dom || {};
  const pathOk = url?.origin === 'https://news.ycombinator.com' && url?.pathname === '/newcomments';
  const domOk = dom.hnMain === true &&
    ((dom.commentRows || 0) > 0 || (dom.itemLinks || 0) >= 10);
  return {
    ok: Boolean(pathOk && domOk),
    detail: pathOk
      ? domOk
        ? 'exact HN /newcomments path plus #hnmain and comment rows/items'
        : 'HN URL matched but #hnmain/comment rows were missing'
      : `HN final URL was not the exact /newcomments page: ${final.url ?? 'unknown'}`,
    observed: {
      url: final.url,
      title: final.title,
      pathname: dom.pathname ?? null,
      search: dom.search ?? null,
      hnMain: dom.hnMain ?? null,
      commentTree: dom.commentTree ?? null,
      commentRows: dom.commentRows ?? null,
      itemLinks: dom.itemLinks ?? null,
      textSample: dom.textSample ?? null,
      loadError: final.loadError,
      domError: dom.error ?? null,
      conditionSignals: conditionSignals(dom),
    },
  };
}

export async function verifyWikipediaJevArticle(page) {
  const final = await readFinalPage(page, wikiDomProbe);
  const url = parsedUrl(final.url);
  const dom = final.dom || {};
  const pathOk = url?.origin === 'https://en.wikipedia.org' && url?.pathname === '/wiki/Jev';
  const headingOk = String(dom.heading || '').trim().toLowerCase() === 'jev';
  const contentOk = dom.content === true && (dom.paragraphCount || 0) > 0;
  const domOk = headingOk && contentOk;
  return {
    ok: Boolean(pathOk && domOk),
    detail: pathOk
      ? domOk
        ? 'exact /wiki/Jev path plus Jev heading and article content paragraphs'
        : `Wiki path matched but article DOM was incomplete: heading=${JSON.stringify(dom.heading ?? null)} paragraphs=${dom.paragraphCount ?? null}`
      : `Wiki final URL was not the exact /wiki/Jev article: ${final.url ?? 'unknown'}`,
    observed: {
      url: final.url,
      title: final.title,
      pathname: dom.pathname ?? null,
      search: dom.search ?? null,
      heading: dom.heading ?? null,
      content: dom.content ?? null,
      paragraphCount: dom.paragraphCount ?? null,
      longParagraphs: dom.longParagraphs ?? null,
      textSample: dom.textSample ?? null,
      loadError: final.loadError,
      domError: dom.error ?? null,
      conditionSignals: conditionSignals(dom),
    },
  };
}

function exactFinalUrl(final, expected) {
  const url = parsedUrl(final.url);
  const dom = final.dom || {};
  return Boolean(expected && url && url.origin === expected.origin &&
    url.pathname === expected.pathname && url.search === expected.search &&
    dom.origin === expected.origin && dom.pathname === expected.pathname && dom.search === expected.search);
}

export async function verifyHackerNewsPage(page, task) {
  const final = await readFinalPage(page, hnDomProbe);
  const dom = final.dom || {};
  const expected = task?.expected;
  const urlOk = exactFinalUrl(final, expected);
  const selected = Array.isArray(dom.selectedPaths) && dom.selectedPaths.includes(expected?.pathname);
  const contentOk = expected?.domKind === 'comments'
    ? (dom.commentRows || 0) > 0 && (dom.commentBodies || 0) > 0
    : expected?.domKind === 'stories' && (dom.storyRows || 0) > 0 && (dom.storyTitles || 0) > 0;
  const domOk = dom.hnMain === true && selected && contentOk;
  return {
    ok: Boolean(urlOk && domOk),
    detail: `HN exact URL/query=${urlOk}; active navigation and ${expected?.domKind ?? 'unknown'} content=${Boolean(domOk)}`,
    observed: { url: final.url, title: final.title, ...dom, loadError: final.loadError, conditionSignals: conditionSignals(dom) },
  };
}

export async function verifyWikipediaArticle(page, task) {
  const final = await readFinalPage(page, wikiDomProbe);
  const dom = final.dom || {};
  const expected = task?.expected;
  const urlOk = exactFinalUrl(final, expected);
  // Deliberately exact English article title: translation is recorded as a failure.
  const headingOk = typeof expected?.heading === 'string' && dom.heading === expected.heading;
  const contentOk = dom.content === true && (dom.paragraphCount || 0) > 0 && String(dom.textSample || '').trim().length > 0;
  return {
    ok: Boolean(urlOk && headingOk && contentOk),
    detail: `Wiki exact URL/query=${urlOk}; exact heading=${headingOk}; article paragraphs=${contentOk}`,
    observed: { url: final.url, title: final.title, ...dom, loadError: final.loadError, conditionSignals: conditionSignals(dom) },
  };
}

export const VERIFIERS = {
  hackerNewsNewComments: verifyHackerNews,
  wikipediaJevArticle: verifyWikipediaJevArticle,
  hackerNewsPage: verifyHackerNewsPage,
  wikipediaArticle: verifyWikipediaArticle,
};

export function getVerifier(name) {
  const verifier = VERIFIERS[name];
  if (typeof verifier !== 'function') throw new Error(`unknown verifier: ${name}`);
  return verifier;
}
