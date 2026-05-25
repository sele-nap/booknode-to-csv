import axios from 'axios';
import * as cheerio from 'cheerio';
import { Element } from 'domhandler';
import { createWriteStream, writeFileSync } from 'fs';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  username: process.env.BN_USERNAME ?? 'ton_username',
  password: process.env.BN_PASSWORD ?? 'ton_mdp',
};

// ── CLI ───────────────────────────────────────────────────────────────────────
// npx ts-node booknode-export.ts <profileSlug> [--debug [shelf]]
const rawArgs = process.argv.slice(2);
const debugIdx = rawArgs.indexOf('--debug');
const DEBUG = debugIdx !== -1;
const debugShelfArg = rawArgs[debugIdx + 1];
const DEBUG_SHELF =
  DEBUG && debugShelfArg && !debugShelfArg.startsWith('-')
    ? debugShelfArg
    : null;
const USERNAME = rawArgs.find((a) => !a.startsWith('-')) ?? '';

if (!USERNAME) {
  console.error(
    'Usage: npx ts-node booknode-export.ts <profileSlug> [--debug [shelf]]',
  );
  process.exit(1);
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const BASE_URL = 'https://booknode.com';
const LOGIN_POST_PATH = '/backend/router.php';
const DELAY_MS = 800;
const SHELF_MAP: Record<string, string> = {
  lu: 'read',
  'en-cours': 'currently-reading',
  'a-lire': 'to-read',
  wishlist: 'to-read',
  abandonne: 'read',
};
const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
};

interface Book {
  title: string;
  author: string;
  isbn: string;
  myRating: number;
  shelf: string;
  dateRead: string;
  dateAdded: string;
  review: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── COOKIE STORE ──────────────────────────────────────────────────────────────
// Gestion manuelle des cookies pour éviter les dépendances externes.
// La session cookie vient uniquement du 302 du login — pas besoin de jar complet.
const cookieStore: Record<string, string> = {};

function storeCookies(setCookieHeader: string[] | string | undefined): void {
  for (const raw of [setCookieHeader ?? []].flat()) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0)
      cookieStore[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieString(): string {
  return Object.entries(cookieStore)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
function get(path: string) {
  return axios.get(`${BASE_URL}${path}`, {
    headers: { ...BASE_HEADERS, Cookie: cookieString() },
    maxRedirects: 5,
  });
}

function post(path: string, data: string) {
  // maxRedirects: 0 pour capturer les cookies du 302 avant la redirection
  return axios.post(`${BASE_URL}${path}`, data, {
    headers: {
      ...BASE_HEADERS,
      Cookie: cookieString(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
  });
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function login(): Promise<void> {
  console.log('🔑 Connexion à BookNode...');

  // Établit la session cookie avant le login
  const homePage = await get('/');
  storeCookies(homePage.headers['set-cookie'] as string[] | undefined);

  const loginRes = await post(
    LOGIN_POST_PATH,
    new URLSearchParams({
      action: 'logmein',
      u: CONFIG.username,
      p: CONFIG.password,
    }).toString(),
  );
  storeCookies(loginRes.headers['set-cookie'] as string[] | undefined);

  const loginJson = loginRes.data as Record<string, unknown>;
  console.log(
    '   Cookies stockés :',
    Object.keys(cookieStore).join(', ') || '(aucun)',
  );
  console.log('   Réponse login    :', JSON.stringify(loginJson));

  if (!loginJson.ok && loginJson.ok !== 1) {
    console.error(
      '❌ Login échoué :',
      loginJson.msg ?? loginJson.error ?? JSON.stringify(loginJson),
    );
    process.exit(1);
  }

  console.log('✅ Connecté !\n');
}

// ── DEBUG ─────────────────────────────────────────────────────────────────────
// --debug <shelf>   → dump /profil/{slug}/bibliotheque?shelf=<shelf>&page=1
// --debug <url>     → dump l'URL exacte si ça commence par /
async function dumpHtml(target: string, page = 1): Promise<void> {
  const isRawPath = target.startsWith('/');
  const path = isRawPath
    ? target
    : `/profil/${USERNAME}/bibliotheque?shelf=${target}&page=${page}`;

  console.log(`🔍 Debug — fetching: ${BASE_URL}${path}\n`);

  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { ...BASE_HEADERS, Cookie: cookieString() },
    maxRedirects: 5,
    validateStatus: () => true,
  });

  const filename = `debug_${target.replace(/\//g, '_').replace(/[?&=]/g, '-')}.html`;
  writeFileSync(filename, res.data as string, 'utf8');

  console.log(`✅ Status ${res.status} → ${filename}`);
  console.log(
    '   Ouvre dans ton navigateur pour repérer la vraie structure des URLs et des sélecteurs CSS.\n',
  );
}

// ── SCRAPING ──────────────────────────────────────────────────────────────────
function parseRating($el: cheerio.Cheerio<Element>): number {
  const dataNoteAttr = $el.attr('data-note');
  if (dataNoteAttr) return Math.round(parseFloat(dataNoteAttr));

  const cls = $el.attr('class') ?? '';
  const match = cls.match(/note_(\d)/);
  if (match) return parseInt(match[1], 10);

  const full = $el.find('.heart_full, .fa-heart, .icon-heart-filled').length;
  return Math.min(full, 5);
}

async function fetchBooksPage(
  shelf: string,
  page: number,
): Promise<{ books: Book[]; hasNext: boolean }> {
  const { data: html } = await get(
    `/profil/${USERNAME}/bibliotheque?shelf=${shelf}&page=${page}`,
  );
  const $ = cheerio.load(html as string);
  const books: Book[] = [];

  $(".book_item, .livre_item, [class*='book-item'], li.book").each((_, el) => {
    const $el = $(el);

    const title =
      $el
        .find(".book_title, .titre, [itemprop='name'], .title a")
        .first()
        .text()
        .trim() ||
      $el.find("a.book_link, a[href*='/livre/']").first().text().trim();

    if (!title) return;

    const author = $el
      .find(".book_author, .auteur, [itemprop='author']")
      .first()
      .text()
      .trim();

    const isbn =
      $el.find("[itemprop='isbn']").attr('content') ??
      $el.attr('data-isbn') ??
      '';

    const myRating = parseRating(
      $el.find(".note, .rating, [class*='note_']").first(),
    );

    const dateReadRaw = $el
      .find(".date_read, .date-lu, [class*='date']")
      .first()
      .text()
      .trim();
    const dateRead = dateReadRaw
      ? new Date(dateReadRaw).toISOString().split('T')[0]
      : '';

    const review = $el
      .find('.review, .commentaire, .avis')
      .first()
      .text()
      .trim();

    books.push({
      title,
      author,
      isbn,
      myRating,
      shelf: SHELF_MAP[shelf] ?? 'read',
      dateRead,
      dateAdded: new Date().toISOString().split('T')[0],
      review,
    });
  });

  const hasNext =
    $("a.next, a[rel='next'], .pagination .next:not(.disabled)").length > 0;

  return { books, hasNext };
}

async function fetchAllBooksForShelf(shelf: string): Promise<Book[]> {
  const allBooks: Book[] = [];
  let page = 1;
  console.log(`  📚 Shelf "${shelf}"...`);

  while (true) {
    try {
      const { books, hasNext } = await fetchBooksPage(shelf, page);
      allBooks.push(...books);
      console.log(`     Page ${page} → ${books.length} livre(s)`);
      if (!hasNext) break;
      page++;
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`     ⚠️ Erreur page ${page} :`, (err as Error).message);
      break;
    }
  }

  return allBooks;
}

// ── CSV GOODREADS ─────────────────────────────────────────────────────────────
function escapeCsv(value: string): string {
  return value.includes(',') || value.includes('"') || value.includes('\n')
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function booksToGoodreadsCsv(books: Book[]): string {
  const columns = [
    'Book Id',
    'Title',
    'Author',
    'Author l-f',
    'Additional Authors',
    'ISBN',
    'ISBN13',
    'My Rating',
    'Average Rating',
    'Publisher',
    'Binding',
    'Number of Pages',
    'Year Published',
    'Original Publication Year',
    'Date Read',
    'Date Added',
    'Bookshelves',
    'Bookshelves with positions',
    'Exclusive Shelf',
    'My Review',
    'Spoiler',
    'Private Notes',
    'Read Count',
    'Owned Copies',
  ];

  const rows = books.map((b, i) => {
    const authorLF = b.author.includes(' ')
      ? b.author.split(' ').reverse().join(', ')
      : b.author;

    return [
      String(i + 1),
      b.title,
      b.author,
      authorLF,
      '',
      b.isbn,
      '',
      String(b.myRating),
      '',
      '',
      '',
      '',
      '',
      '',
      b.dateRead,
      b.dateAdded,
      b.shelf,
      '',
      b.shelf,
      b.review,
      '',
      '',
      b.shelf === 'read' ? '1' : '0',
      '0',
    ]
      .map(escapeCsv)
      .join(',');
  });

  return [columns.join(','), ...rows].join('\n');
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  await login();

  if (DEBUG) {
    await dumpHtml(DEBUG_SHELF ?? Object.keys(SHELF_MAP)[0]);
    return;
  }

  console.log(`🔮 Export BookNode → Goodreads CSV pour « ${USERNAME} »\n`);

  const allBooks: Book[] = [];
  for (const shelf of Object.keys(SHELF_MAP)) {
    allBooks.push(...(await fetchAllBooksForShelf(shelf)));
    await sleep(DELAY_MS);
  }

  if (allBooks.length === 0) {
    console.warn(
      '⚠️  Aucun livre trouvé — les sélecteurs CSS ont peut-être changé.\n' +
        `   Lance : npx ts-node booknode-export.ts ${USERNAME} --debug lu`,
    );
    process.exit(1);
  }

  const csv = booksToGoodreadsCsv(allBooks);
  const outFile = `booknode_${USERNAME}_export.csv`;
  createWriteStream(outFile).end(csv, 'utf8');

  console.log(`\n✅ ${allBooks.length} livre(s) exporté(s) → ${outFile}`);
  console.log(
    '   Goodreads : Settings → Import books → Goodreads CSV\n' +
      '   Pagebound : Settings → Import → Goodreads',
  );
}

main().catch((err) => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
