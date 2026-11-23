# Fuel

Private food and weight log. Lives at `/nine-sets/fuel/` on GitHub Pages, next to Nine Sets.

## Connect the Google Sheet (one time)

1. Open the "Fuel log" Google Sheet (personal Gmail account), then Extensions > Apps Script. The script creates its tabs on first run.
2. Paste in `sheet-sync.gs`, save, then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
3. The web app URL is built into `index.html` (SYNC_DEFAULT), so a fresh install syncs straight away. To point at a different script, change it in More > Google Sheet sync or open `.../fuel/#sync=<URL>`.

## Sheet tabs

- **Entries**: one row per logged food (date, time, food, amount, kcal, macros, fibre, sugar, sat fat, sodium).
- **Daily**: totals per day with that day's targets and scale/trend weight.
- **Weight**, **Targets**, **Foods**, **Settings**: full copies sent by the app.
- **Coach**: add a row (start date, kcal, protein, fat, carbs, note) to override targets. The app picks up the newest row when it opens.

## Food database

Search runs on the phone against an offline database, so results appear as you type and work without signal.

- `data/common.json`: about 4,400 generic foods from USDA FoodData Central (SR Legacy + Foundation, public domain), with household portions like "1 cup" or "1 large". Meat, fish, dairy and egg categories are left out.
- `data/au.json`: about 69,000 products sold in Australia from Open Food Facts (ODbL), with peanut and vegan flags.
- `.github/workflows/fuel-foods.yml` rebuilds both every Monday with `tools/build_foods.py` and commits them if they changed. Run it from the Actions tab to refresh sooner.
- `search.js` is a Web Worker that downloads the files once (about 3 MB), keeps them in the browser cache, refreshes them weekly, and does typo-tolerant, synonym-aware search (capsicum = bell pepper, chickpea = garbanzo, Weet-Bix = weetbix).
- Anything not in the database can still be found with "Search Open Food Facts online", by barcode, or created from the label.
