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
