# Spendly

A lightweight, mobile-first expense tracker built with plain HTML, CSS and JavaScript.

## Features

- Add, edit and delete expenses
- Weekly (Monday–Sunday), monthly, rolling three-calendar-month and yearly totals
- Recent expenses and searchable full history
- CSV export and JSON backup/restore
- Installable PWA with offline app-shell support
- Local-first storage using the browser's `localStorage`
- No build tools, database, API keys or backend required

## Project structure

```text
Spendly/
├── index.html
├── manifest.json
├── sw.js
├── netlify.toml
├── .gitignore
├── README.md
└── icons/
    ├── icon-180.png
    ├── icon-192.png
    ├── icon-512.png
    └── icon-512-maskable.png
```

## Run locally in VS Code

1. Extract the ZIP.
2. Open the `Spendly` folder in VS Code.
3. Install the **Live Server** extension (Ritwick Dey), if you do not already have it.
4. Right-click `index.html` and choose **Open with Live Server**.
5. Your browser should open a local address, usually `http://127.0.0.1:5500`.

The service worker can run on `localhost`. For the actual iPhone installation, deploy the project to an HTTPS host first.

## Publish to GitHub

1. Create a new GitHub repository, e.g. `spendly`.
2. Keep it empty when creating it (do not add a README or licence; this folder already contains a README).
3. In VS Code, open **Source Control**.
4. Choose **Initialize Repository** if prompted.
5. Stage the files, enter a message such as `Initial Spendly PWA`, and commit.
6. Choose **Publish Branch** / **Publish to GitHub** and select the repository you created.

Alternatively, use GitHub Desktop: add this folder as an existing repository, commit, then publish it.

## Deploy to Netlify using GitHub

1. Sign in at https://app.netlify.com/.
2. Choose **Add new project** → **Import an existing project**.
3. Choose GitHub and authorize Netlify.
4. Select your `spendly` repository.
5. Build command: leave blank.
6. Publish directory: `.` (a single dot).
7. Deploy the site.

The included `netlify.toml` sets the publish directory to the project root. Each push to the connected GitHub branch triggers a new deployment. Keep this repository free of private information; a public repository's source code is visible to everyone.

## Install on iPhone 11 Pro

1. Open the deployed `https://...netlify.app` address in Safari (not an in-app browser).
2. Tap the Share icon.
3. Scroll and choose **Add to Home Screen**.
4. Keep the name as `Spendly`, enable **Open as Web App** if that option appears, then tap **Add**.
5. Launch Spendly from the new Home Screen icon.

The service worker caches the app shell for offline opening after the first successful visit. Expense data is stored separately in Safari's local browser storage.

## Important data and privacy notes

- Expense records are stored on the device/browser where they were entered. There is no account and no automatic sync between your PC and iPhone.
- The website's HTML/JavaScript is public to anyone with the URL. Do not put private records, credentials or API keys in this repository.
- Clearing Safari website data, removing app data, or changing the site origin can erase locally stored expenses.
- Use **History → Download backup** regularly. Store the JSON backup somewhere safe.
- Before changing the storage implementation in a future release, keep the key `spendly_expenses_v1` or write a migration so existing records are preserved.
- Offline app-shell caching does not mean records are backed up. The backup file is still important.

## Updating Spendly later

1. Edit the files in VS Code.
2. Test using Live Server.
3. Commit and push the changes to the GitHub branch connected to Netlify.
4. Netlify automatically deploys the update.
5. Reopen Spendly on iPhone while online to let the service worker download the updated app shell.

When changing cached assets in `sw.js`, increment `CACHE_NAME` (for example, `spendly-shell-v2`) so devices know to install the new cache.

## Current scope

This project intentionally keeps one core job: recording expenses and showing totals. There is no income tracker, budgeting, categories, bank connection or cloud synchronization.
