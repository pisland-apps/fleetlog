# FleetLog

> **Vehicle Maintenance & Depreciation Tracker** — A privacy-first, offline-capable PWA for managing your vehicle fleet.

[![PWA](https://img.shields.io/badge/PWA-Offline%20Ready-5A0FC8?logo=pwa)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
[![Encryption](https://img.shields.io/badge/Encryption-AES--256%20GCM-green?logo=letsencrypt)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
[![IndexedDB](https://img.shields.io/badge/Storage-IndexedDB-blue?logo=indexeddb)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔒 **Passcode Lock Screen** | Full-screen auth overlay with AES-256-GCM encryption via Web Crypto API |
| 🗄️ **IndexedDB + Encryption** | All vehicle data and entries are encrypted at rest using PBKDF2-derived keys |
| 📱 **PWA Offline Support** | Installable on mobile/desktop; works offline via Service Worker caching |
| 🚗 **Multi-Vehicle Support** | Track unlimited vehicles with individual dashboards |
| 🔧 **Maintenance Log** | Record costs, parts, service fees with supplier & odometer tracking |
| 📉 **Depreciation Tracking** | Auto-calculates current book value against initial value |
| 🏦 **Bank Loan Ledger** | Dedicated payment history for vehicle financing |
| 📎 **File Attachments** | Attach receipts, registration cards, or photos (5 MB limit per file) |
| 💱 **Multi-Currency** | Configurable currency symbol (RM, USD, EUR, GBP, JPY, etc.) |
| 💾 **Import / Export** | Encrypted or plaintext JSON backup/restore |
| 🖨️ **Print Reports** | Landscape/portrait optimized print styles with breakdown tables |

---

## 🚀 Quick Start

### Option A: GitHub Pages (Recommended)
1. Fork or upload this repository to GitHub.
2. Go to **Settings → Pages** and set the source to the root branch.
3. Visit `https://<your-username>.github.io/fleetlog-pwa/`.
4. On first launch, create a passcode to initialize the encrypted store.

### Option B: Local Static Server
```bash
cd fleetlog-pwa
# Python 3
python -m http.server 8080
# Node.js
npx serve .
# PHP
php -S localhost:8080
```
Then open `http://localhost:8080`.

> ⚠️ **Important:** Service Workers require `https` or `localhost`. Opening `file://` directly will not register the SW.

---

## 📁 File Structure

```
fleetlog-pwa/
├── index.html          # Main application (single-page)
├── manifest.json       # Web App Manifest for installability
├── sw.js               # Service Worker (Stale-While-Revalidate)
├── README.md           # This file
└── icons/
    ├── favicon.ico
    ├── icon-72x72.png
    ├── icon-96x96.png
    ├── icon-128x128.png
    ├── icon-144x144.png
    ├── icon-152x152.png
    ├── icon-192x192.png
    ├── icon-384x384.png
    └── icon-512x512.png
```

---

## 🔐 Security Architecture

```
User Passcode
     │
     ▼
PBKDF2 (100k iterations, SHA-256, random 16-byte salt)
     │
     ▼
AES-256-GCM Key ──► Encrypt/Decrypt all IndexedDB records
```

- **Salt** and **verifier** are stored in IndexedDB `config` store.
- **Vehicles** and **entries** are stored as encrypted payloads; raw data never touches disk unencrypted.
- If the passcode is lost, **data cannot be recovered** — there is no backdoor.

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML5 + Tailwind CSS (CDN) + Vanilla JS
- **Storage:** IndexedDB (native browser API)
- **Crypto:** Web Crypto API (`SubtleCrypto`)
- **PWA:** Service Worker + Web App Manifest
- **Icons:** Generated PNG set (72×72 … 512×512)

---

## 📦 Deployment Notes

### Caching Strategy
| Asset Type | Strategy | Reason |
|------------|----------|--------|
| All cached assets | **Stale-While-Revalidate** | Fast response + background update |
| Dynamic data | **Network Only** | All data lives in local IndexedDB |

### Updating the App
When you push a new version, bump **both** of these together — they live in
different files and do not sync automatically:
1. `CACHE_NAME` in `sw.js` (e.g., `fleetlog-pwa-v1.9`) — this busts the
   service worker's asset cache so old clients pick up the new files.
2. `APP_VERSION` / `APP_VERSION_DATE` near the top of `app.js` — this is the
   human-readable label shown in the small badge in the corner of the app,
   visible even on the lock screen before authentication. It's a display
   label only and has no effect on caching.

Each file has a comment pointing at the other as a reminder. The badge only
tells you what code shipped in this build, not what the browser is actually
running — if you deploy and the number in the corner doesn't match what you
expect, that's the signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the
site's Service Worker/cache in devtools, not to assume the deploy failed.

3. The new Service Worker will install and activate, clearing old caches.
4. Users will get the latest app shell on the next visit.

---

## 📎 Attachments & In-App Viewer

Vehicles and maintenance/depreciation/other entries can each carry **any
number** of file attachments (image, PDF, or Word doc — 5 MB cap per file,
enforced on upload):
- **Vehicle Details** — for registration cards, duty-exemption certs, etc.
- **Maintenance Log entries** — for receipts, invoices, workshop reports.

In the Add/Edit modal, tap **➕ Add Attachment** to pick one or more files
(repeat as many times as needed); each attachment appears as a chip with
its own **✕** to remove it. Nothing is deleted or replaced until you tap
**Save** — the attachment list in the modal at that moment is exactly what
gets saved, so removing a chip and saving actually removes that file.

Clicking an attachment opens it in an in-app viewer instead of the browser:
- **Images** render directly, and also show as a small thumbnail "logo"
  next to the entry/vehicle wherever they're referenced — if there's no
  image attachment, no thumbnail is shown.
- **PDFs** are rendered page-by-page onto `<canvas>` via pdf.js, avoiding
  the inconsistent (and sometimes blocked) way browsers handle PDFs in
  `<iframe>`s or navigated-to blob/data URLs.
- Other file types (e.g. `.doc`/`.docx`) show a "no preview available"
  message with a **Save a Copy** button, which is also available for
  images/PDFs if you want the actual file rather than just viewing it.

This mirrors the attachment viewer in the companion Wealth Planner app.

---

## 📝 Changelog

### v1.9
- ✅ **Multiple Attachments**: Vehicles and entries can now carry any number of image/PDF/doc attachments instead of just one — tap ➕ Add Attachment to add more, each with its own remove (✕) chip
- 🐛 **Fixed**: Removing an attachment and saving now actually deletes it. Previously, clicking the ✕ next to an existing attachment reset the upload field but the save logic silently fell back to the old file, so the attachment was never actually removed or replaced.

### v1.8
- ✅ **In-App Attachment Viewer**: Images and PDFs on vehicles/entries now open in an in-app viewer (pdf.js for PDFs, Blob object URLs for images) instead of downloading straight to disk
- ✅ **Attachment Thumbnails**: Maintenance entries and Vehicle Details show a small image thumbnail when the attachment is an image; blank when there's no attachment
- ✅ **Version Badge**: Small corner badge showing `APP_VERSION` from `app.js`, visible even on the lock screen before authentication

### v1.1
- ✅ **Service Worker**: Stale-While-Revalidate strategy with v1.1 cache
- ✅ **File Size Limit**: 5 MB cap on attachments to prevent IndexedDB bloat
- ✅ **Multi-Currency**: Added 14 configurable currency symbols via dropdown
- ✅ **PWA Meta Tags**: `theme-color`, `apple-mobile-web-app-capable`, `apple-touch-icon`

---

## 📝 License

MIT — Free for personal and commercial use.

---

## 🙋 FAQ

**Q: Can I use this without internet?**  
A: Yes. After the first load, the app shell is cached. All data is stored locally in IndexedDB.

**Q: How do I change my passcode?**  
A: Currently, you must export your data, clear site storage, re-import, and set a new passcode during first-time setup.

**Q: Is there a file size limit for attachments?**  
A: Yes — 5 MB per file. Attachments are Base64-encoded and encrypted. Practical total limit depends on your browser's IndexedDB quota (typically 50–200 MB).

**Q: Does it work on iOS Safari?**  
A: Yes. Add to Home Screen via the Share menu. Note that iOS may purge IndexedDB if the device is low on storage and the app is unused.
