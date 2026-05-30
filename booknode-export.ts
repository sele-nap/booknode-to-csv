import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';

// Usage: npx ts-node booknode-export.ts <profileSlug|userId> [--debug] [--no-isbn]
const args     = process.argv.slice(2);
const DEBUG    = args.includes('--debug');
const NO_ISBN  = args.includes('--no-isbn');
const USERNAME = args.find((a) => !a.startsWith('-')) ?? '';

if (!USERNAME) {
  console.error('Usage: npx ts-node booknode-export.ts <profileSlug|userId> [--no-isbn]');
  process.exit(1);
}

const BASE_URL = 'https://booknode.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
};

// BookNode has no individual ratings — the list determines the star count.
const LIST_MAP: Record<number, { shelf: string; rating: number } | null> = {
  1:  { shelf: 'read',              rating: 5 }, // Diamond
  2:  { shelf: 'read',              rating: 4 }, // Gold
  3:  { shelf: 'read',              rating: 3 }, // Silver
  4:  { shelf: 'read',              rating: 2 }, // Bronze
  5:  { shelf: 'read',              rating: 0 }, // Also read
  6:  { shelf: 'to-read',           rating: 0 }, // Wishlist
  7:  null,                                       // Trash — skipped
  8:  { shelf: 'currently-reading', rating: 0 }, // Currently reading
  9:  { shelf: 'read',              rating: 0 }, // Did not enjoy
  10: { shelf: 'to-read',           rating: 0 }, // To-read pile
};

// Hoisted so it isn't recompiled on every resolveIsbn call
const VOLUME_RE = /,?\s*(tome|vol\.?|volume|t\.|partie|part)\s*\d+/gi;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Types ─────────────────────────────────────────────────────────────────────
interface ApiBook {
  type: 'creative';
  id: number;
  name: string;
  person: { _prenom: string; _nom: string; nom: string };
}
interface ApiGroupRef { type: 'group'; id: number }
interface ApiResponse {
  front_content: Record<string, (ApiBook | ApiGroupRef)[]>;
  groups: Record<string, { content: ApiBook[] }>;
}
interface Book {
  title: string;
  author: string;
  authorLF: string; // "Last, First" — built from structured API fields
  myRating: number;
  shelf: string;
  isbn: string;
  isbn13: string;
}

// ── Step 1: resolve userId ────────────────────────────────────────────────────
async function fetchUserId(): Promise<string> {
  if (/^\d+$/.test(USERNAME)) return USERNAME;

  console.log(`🔍 Looking up user ID for "${USERNAME}"...`);
  for (const path of [`/profil/${USERNAME}/biblio`, `/profil/${USERNAME}/bibliotheque`]) {
    try {
      const { data: html } = await axios.get(`${BASE_URL}${path}`, {
        headers: HEADERS, maxRedirects: 5, validateStatus: (s) => s < 500,
      });
      const userId = cheerio.load(html as string)('main[data-id]').attr('data-id');
      if (userId) { console.log(`   userId = ${userId}\n`); return userId; }
    } catch { /* try next path */ }
  }
  throw new Error(
    `Could not find user ID for "${USERNAME}".\n` +
    `  → Pass it directly: npx ts-node booknode-export.ts 501202`,
  );
}

// ── Step 2: fetch library ─────────────────────────────────────────────────────
async function fetchLibrary(userId: string): Promise<ApiResponse> {
  console.log('📚 Loading library...');
  const { data } = await axios.get(`${BASE_URL}/biblio-api/load/${userId}`, {
    headers: { ...HEADERS, Accept: 'application/json' },
  });
  return data as ApiResponse;
}

// ── Step 3: flatten to books ──────────────────────────────────────────────────
function extractBooks(library: ApiResponse): Book[] {
  const books: Book[] = [];

  for (const [listIdStr, items] of Object.entries(library.front_content)) {
    const mapping = LIST_MAP[parseInt(listIdStr, 10)];
    if (!mapping) continue;

    for (const item of items) {
      const creatives =
        item.type === 'creative'
          ? [item as ApiBook]
          : library.groups[String(item.id)]?.content ?? [];

      for (const book of creatives) {
        const { _prenom, _nom, nom } = book.person;
        const author   = [_prenom, _nom].join(' ').trim() || nom;
        const authorLF = [_nom, _prenom].filter(Boolean).join(', ') || nom;
        books.push({ title: book.name, author, authorLF, shelf: mapping.shelf, myRating: mapping.rating, isbn: '', isbn13: '' });
      }
    }
  }

  return books;
}

// ── Step 4: ISBN resolution via Open Library ──────────────────────────────────
async function resolveIsbn(title: string, author: string): Promise<{ isbn: string; isbn13: string }> {
  const cleanTitle = title.replace(VOLUME_RE, '').trim();

  for (const query of [{ title: cleanTitle, author }, { title: cleanTitle }]) {
    try {
      const { data } = await axios.get('https://openlibrary.org/search.json', {
        params: { ...query, limit: 5, fields: 'isbn' },
        timeout: 8000,
      });
      const docs = (data as { docs: Array<{ isbn?: string[] }> }).docs;
      for (const doc of docs) {
        if (!doc.isbn?.length) continue;
        const i13 = doc.isbn.find((i) => i.length === 13 && /^97[89]/.test(i));
        const i10 = doc.isbn.find((i) => i.length === 10);
        if (i13 || i10) return { isbn: i10 ?? '', isbn13: i13 ?? '' };
      }
    } catch { /* timeout or rate-limit — skip */ }
  }

  return { isbn: '', isbn13: '' };
}

async function resolveAllIsbns(books: Book[]): Promise<void> {
  const CONCURRENCY = 5;
  let found = 0;

  console.log(`\n🔎 Resolving ISBNs via Open Library (${books.length} books)...`);

  for (let i = 0; i < books.length; i += CONCURRENCY) {
    const batch   = books.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((b) => resolveIsbn(b.title, b.author)));

    for (let j = 0; j < batch.length; j++) {
      batch[j].isbn   = results[j].isbn;
      batch[j].isbn13 = results[j].isbn13;
      if (results[j].isbn || results[j].isbn13) found++;
    }

    const done = Math.min(i + CONCURRENCY, books.length);
    process.stdout.write(`\r   [${done}/${books.length}] ${Math.round((done / books.length) * 100)}% — ${found} ISBNs found   `);
    if (done < books.length) await sleep(250);
  }

  console.log(`\n   ✅ ${found}/${books.length} ISBNs resolved (${Math.round((found / books.length) * 100)}%)\n`);
}

// ── CSV (Goodreads format) ────────────────────────────────────────────────────
function escapeCsv(v: string): string {
  return v.includes(',') || v.includes('"') || v.includes('\n')
    ? `"${v.replace(/"/g, '""')}"`
    : v;
}

function toCsv(books: Book[]): string {
  const header = [
    'Book Id', 'Title', 'Author', 'Author l-f', 'Additional Authors',
    'ISBN', 'ISBN13', 'My Rating', 'Publisher', 'Binding',
    'Number of Pages', 'Year Published', 'Original Publication Year',
    'Date Read', 'Date Added', 'Bookshelves', 'Bookshelves with positions',
    'Exclusive Shelf', 'My Review', 'Spoiler', 'Private Notes',
    'Read Count', 'Owned Copies',
  ];

  // Use local date to avoid UTC-offset day shift
  const d     = new Date();
  const today = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

  // Goodreads expects ISBNs wrapped in ="..." to prevent Excel scientific notation
  const rows = books.map((b, i) => [
    String(i + 1), b.title, b.author, b.authorLF,
    '', b.isbn ? `="${b.isbn}"` : '', b.isbn13 ? `="${b.isbn13}"` : '', String(b.myRating),
    '', '', '', '', '',
    '', today,
    b.shelf, '', b.shelf,
    '', '', '',
    b.shelf === 'read' ? '1' : '0', '0',
  ].map(escapeCsv).join(','));

  return [header.join(','), ...rows].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const userId  = await fetchUserId();
  const library = await fetchLibrary(userId);

  if (DEBUG) {
    const out = `debug_api_${USERNAME}.json`;
    writeFileSync(out, JSON.stringify(library, null, 2), 'utf8');
    console.log(`✅ Raw API response saved → ${out}`);
    return;
  }

  console.log(`🔮 Exporting BookNode → Goodreads CSV for "${USERNAME}"\n`);
  const books = extractBooks(library);

  if (books.length === 0) {
    console.warn('⚠️  No books found — is the profile private?');
    process.exit(1);
  }

  if (!NO_ISBN) await resolveAllIsbns(books);

  const outFile = `booknode_${USERNAME}_export.csv`;
  writeFileSync(outFile, toCsv(books), 'utf8');

  console.log(`✅ ${books.length} book(s) exported → ${outFile}`);
  console.log('   Goodreads : Settings → Import books → Goodreads CSV');
  console.log('   Pagebound : Settings → Import → Goodreads');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
