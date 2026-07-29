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
When you push a new version:
1. Bump `CACHE_NAME` in `sw.js` (e.g., `fleetlog-pwa-v1.2`).
2. The new Service Worker will install and activate, clearing old caches.
3. Users will get the latest app shell on the next visit.

---

## 📝 Changelog

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
