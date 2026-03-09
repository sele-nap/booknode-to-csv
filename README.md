# booknode-to-csv

Exporte ta bibliothèque BookNode en CSV (compatible Goodreads / Pagebound).

## Installation

```bash
npm install axios cheerio
npm install -D ts-node typescript @types/node
```

## Utilisation

```bash
npx ts-node booknode-export.ts <pseudo_booknode>
```

Génère un fichier `booknode_<pseudo>_export.csv`.

## Import dans Pagebound

**Settings → Import books → Goodreads CSV**

## Étagères exportées

| BookNode | Goodreads |
|---|---|
| Lu | read |
| En cours | currently-reading |
| À lire | to-read |
| Wishlist | to-read |
| Abandonné | read |

## Notes

- Le profil doit être **public**
- Si aucun livre n'est trouvé, les sélecteurs CSS ont peut-être changé — inspecte ta page BookNode avec les DevTools et adapte `fetchBooksPage()` en conséquence
