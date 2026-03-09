import axios from "axios";
import * as cheerio from "cheerio";
import { Element } from "domhandler";
import { createWriteStream } from "fs";

const USERNAME = process.argv[2];
if (!USERNAME) {
  console.error("Usage: npx ts-node booknode-export.ts <booknode_username>");
  process.exit(1);
}

const BASE_URL = "https://booknode.com";
const DELAY_MS = 800; 

const SHELF_MAP: Record<string, string> = {
  lu: "read",
  "en-cours": "currently-reading",
  "a-lire": "to-read",
  "wishlist": "to-read",
  "abandonne": "read",
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

const headers = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

function parseRating($el: cheerio.Cheerio<Element>): number {
  const dataNoteAttr = $el.attr("data-note");
  if (dataNoteAttr) return Math.round(parseFloat(dataNoteAttr));

  const cls = $el.attr("class") ?? "";
  const match = cls.match(/note_(\d)/);
  if (match) return parseInt(match[1], 10);

  const full = $el.find(".heart_full, .fa-heart, .icon-heart-filled").length;
  if (full > 0) return Math.min(full, 5);

  return 0;
}


async function fetchBooksPage(
  username: string,
  shelf: string,
  page: number
): Promise<{ books: Book[]; hasNext: boolean }> {
  const url = `${BASE_URL}/profil/${username}/bibliotheque?shelf=${shelf}&page=${page}`;

  const { data: html } = await axios.get(url, { headers });
  const $ = cheerio.load(html);

  const books: Book[] = [];

  $(".book_item, .livre_item, [class*='book-item'], li.book").each((_, el) => {
    const $el = $(el);

    const title =
      $el.find(".book_title, .titre, [itemprop='name'], .title a").first().text().trim() ||
      $el.find("a.book_link, a[href*='/livre/']").first().text().trim();

    const author =
      $el.find(".book_author, .auteur, [itemprop='author']").first().text().trim();

    const isbn =
      $el.find("[itemprop='isbn']").attr("content") ??
      $el.attr("data-isbn") ??
      "";

    const myRating = parseRating($el.find(".note, .rating, [class*='note_']").first());

    const dateReadRaw = $el.find(".date_read, .date-lu, [class*='date']").first().text().trim();
    const dateRead = dateReadRaw ? new Date(dateReadRaw).toISOString().split("T")[0] : "";
    const dateAdded = new Date().toISOString().split("T")[0];

    const review = $el.find(".review, .commentaire, .avis").first().text().trim();

    if (title) {
      books.push({
        title,
        author,
        isbn,
        myRating,
        shelf: SHELF_MAP[shelf] ?? "read",
        dateRead,
        dateAdded,
        review,
      });
    }
  });

  const hasNext =
    $("a.next, a[rel='next'], .pagination .next:not(.disabled)").length > 0;

  return { books, hasNext };
}


async function fetchAllBooksForShelf(
  username: string,
  shelf: string
): Promise<Book[]> {
  const allBooks: Book[] = [];
  let page = 1;

  console.log(`  📚 Fetching shelf "${shelf}"...`);

  while (true) {
    try {
      const { books, hasNext } = await fetchBooksPage(username, shelf, page);
      allBooks.push(...books);
      console.log(`     Page ${page} → ${books.length} livre(s)`);

      if (!hasNext) break;
      page++;
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`     ⚠️ Erreur page ${page} (${shelf}) :`, (err as Error).message);
      break;
    }
  }

  return allBooks;
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function booksToGoodreadsCsv(books: Book[]): string {
  const columns = [
    "Book Id",
    "Title",
    "Author",
    "Author l-f",
    "Additional Authors",
    "ISBN",
    "ISBN13",
    "My Rating",
    "Average Rating",
    "Publisher",
    "Binding",
    "Number of Pages",
    "Year Published",
    "Original Publication Year",
    "Date Read",
    "Date Added",
    "Bookshelves",
    "Bookshelves with positions",
    "Exclusive Shelf",
    "My Review",
    "Spoiler",
    "Private Notes",
    "Read Count",
    "Owned Copies",
  ];

  const rows = books.map((b, i) => {
    const authorLF = b.author.includes(" ")
      ? b.author.split(" ").reverse().join(", ")
      : b.author;

    return [
      String(i + 1),          // Book Id (factice)
      b.title,
      b.author,
      authorLF,
      "",                      // Additional Authors
      b.isbn,
      "",                      // ISBN13
      String(b.myRating),
      "",                      // Average Rating
      "",                      // Publisher
      "",                      // Binding
      "",                      // Number of Pages
      "",                      // Year Published
      "",                      // Original Publication Year
      b.dateRead,
      b.dateAdded,
      b.shelf,
      "",                      // Bookshelves with positions
      b.shelf,                 // Exclusive Shelf
      b.review,
      "",                      // Spoiler
      "",                      // Private Notes
      b.shelf === "read" ? "1" : "0",
      "0",                     // Owned Copies
    ]
      .map(escapeCsv)
      .join(",");
  });

  return [columns.join(","), ...rows].join("\n");
}

async function main() {
  console.log(`\n🔮 Export BookNode → Pagebound pour « ${USERNAME} »\n`);

  const shelves = Object.keys(SHELF_MAP);
  const allBooks: Book[] = [];

  for (const shelf of shelves) {
    const books = await fetchAllBooksForShelf(USERNAME, shelf);
    allBooks.push(...books);
    await sleep(DELAY_MS);
  }

  if (allBooks.length === 0) {
    console.warn(
      "\n⚠️  Aucun livre trouvé. Le profil est peut-être privé ou les sélecteurs CSS " +
      "ont changé. Ouvre les DevTools sur ta page BookNode et adapte les sélecteurs " +
      "dans fetchBooksPage() si nécessaire."
    );
    process.exit(1);
  }

  const csv = booksToGoodreadsCsv(allBooks);
  const outFile = `booknode_${USERNAME}_export.csv`;
  createWriteStream(outFile).end(csv, "utf8");

  console.log(`\n✅ ${allBooks.length} livre(s) exporté(s) → ${outFile}`);
  console.log("   Settings → Import books → Goodreads CSV\n");
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});