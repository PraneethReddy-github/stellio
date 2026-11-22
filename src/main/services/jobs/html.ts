import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

/** Below this the page is treated as a failed extraction (JS-rendered, blocked or login page). */
export const MIN_JD_CHARS = 400;

const DROP =
  'script,style,noscript,iframe,frame,frameset,object,embed,applet,svg,canvas,video,audio,template,link,base,img,picture,input,button,select,textarea,option,datalist,dialog';
const CHROME =
  'nav,footer,aside,header[role=banner],[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true]';
const SAFE_URL = /^(https?:|mailto:|#|\/|\.|[^:]*$)/i;

// linkedom's own typings need the DOM lib, which the main process does not have: describe what we use.
interface El {
  remove(): void;
  replaceWith(...nodes: unknown[]): void;
  childNodes: Iterable<unknown>;
  attributes: Iterable<{ name: string; value: string }>;
  removeAttribute(name: string): void;
  textContent: string | null;
  innerHTML: string;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  cloneNode(deep: boolean): El;
}
interface Doc extends El {
  title: string;
  body: El;
}
const parse = (html: string): Doc => (parseHTML(html) as unknown as { document: Doc }).document;

/** Removes everything executable or interactive: scripts, frames, form controls, event handlers, odd URL schemes. */
function sanitize(document: Doc, { chrome }: { chrome: boolean }): void {
  for (const el of document.querySelectorAll(chrome ? `${DROP},${CHROME}` : DROP)) el.remove();
  // Whole pages are sometimes wrapped in one <form> (ASP.NET): keep its content, drop the form.
  for (const form of document.querySelectorAll('form')) form.replaceWith(...Array.from(form.childNodes));
  for (const el of document.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'action') && !SAFE_URL.test(attr.value.trim()))
        el.removeAttribute(attr.name);
    }
  }
}

function turndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  td.remove(['script', 'style']);
  return td;
}

const tidy = (md: string): string =>
  md
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** HTML fragment (e.g. an ATS description) to sanitized Markdown. */
export function fragmentToMarkdown(html: string): string {
  const document = parse(`<!doctype html><html><body>${html}</body></html>`);
  sanitize(document, { chrome: false });
  return tidy(turndown().turndown(document.body.innerHTML));
}

const WALL_PHRASES = [
  /sign[ -]?in/i,
  /log[ -]?in/i,
  /join now/i,
  /create (?:an )?account/i,
  /verify you are (?:a )?human/i,
  /enable javascript/i,
  /are you a robot/i,
  /captcha/i,
  /access denied/i,
  /forgot (?:your )?password/i,
];

/** Short text that is mostly sign-in / bot-check wording. */
export function looksLikeLoginWall(markdown: string, hasPasswordField: boolean): boolean {
  if (markdown.length >= 2500) return false;
  if (hasPasswordField) return true;
  return WALL_PHRASES.filter((re) => re.test(markdown)).length >= 2;
}

export interface Extracted {
  markdown: string;
  title: string | null;
  loginWall: boolean;
}

/** Readability on a sanitized linkedom DOM, then Markdown. Page scripts are never executed. */
export function extractPage(html: string): Extracted {
  const document = parse(html);
  const title = document.title.trim() || null;
  const h1 = document.querySelector('h1')?.textContent?.trim().replace(/\s+/g, ' ');
  const hasPasswordField = document.querySelector('input[type=password]') !== null;
  sanitize(document, { chrome: false });
  const td = turndown();

  let article = '';
  try {
    const parsed = new Readability(document.cloneNode(true) as never, {
      charThreshold: 200,
    }).parse();
    if (parsed?.content) article = tidy(td.turndown(parsed.content));
  } catch {
    // Readability can throw on odd DOMs: fall through to the body
  }
  let markdown = article;
  if (article.length < MIN_JD_CHARS) {
    sanitize(document, { chrome: true });
    const body = tidy(td.turndown(document.body.innerHTML));
    if (body.length > article.length) markdown = body;
  }
  // Readability treats the page's <h1> as the article title and drops it from the body: keep it, it is the job title.
  if (h1 && markdown && !markdown.includes(h1)) markdown = `# ${h1}\n\n${markdown}`;
  return { markdown, title, loginWall: looksLikeLoginWall(markdown, hasPasswordField) };
}
