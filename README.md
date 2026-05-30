# booknode-to-csv

Export your BookNode library to a Goodreads-compatible CSV (also works with Pagebound).

## Installation

```bash
npm install
```

## Usage

```bash
# By profile slug (auto-resolves the user ID)
npx ts-node booknode-export.ts <booknode_username>

# By userId (more reliable if slug resolution fails)
npx ts-node booknode-export.ts <userId>

# Skip ISBN resolution (faster, less accurate Goodreads matching)
npx ts-node booknode-export.ts <userId> --no-isbn
```

To find your `userId`: open your library page in Chrome → DevTools → Network tab → look for the request `biblio-api/load/<userId>`.

Generates a file `booknode_<username_or_id>_export.csv`.

## Importing

- **Goodreads**: Settings → Import books → Goodreads CSV
- **Pagebound**: Settings → Import → Goodreads

## List mapping

BookNode has no individual star ratings — the list a book belongs to determines its exported rating.

| BookNode list       | Goodreads shelf     | Stars |
| ------------------- | ------------------- | ----- |
| Liste de diamant    | read                | ★★★★★ |
| Liste d'Or          | read                | ★★★★  |
| Liste d'argent      | read                | ★★★   |
| Liste de bronze     | read                | ★★    |
| J'ai lu aussi       | read                | —     |
| Mes envies          | to-read             | —     |
| Ma PAL              | to-read             | —     |
| En cours            | currently-reading   | —     |
| Pas apprécié        | read                | —     |
| Poubelle            | *(skipped)*         | —     |

## Debug mode

```bash
npx ts-node booknode-export.ts <username_or_id> --debug
```

Saves the raw API response to `debug_api_<username>.json` for inspection.

## Notes

- The profile must be **public**
- ISBNs are resolved via the [Open Library API](https://openlibrary.org/dev/docs/api) to improve Goodreads matching accuracy (~55% success rate, lower for manga/comics)
