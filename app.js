const DB_NAME = 'FleetLogDB';
const DB_VERSION = 4;

// ---------------------------------------------------------------------
// APP_VERSION / APP_VERSION_DATE — the human-readable label shown in the
// small corner badge (#versionBadge in index.html), including on the
// lock screen before authentication. This only tells you what code
// shipped in this build, not what the browser is actually running — if
// you deploy and the badge doesn't change, hard-refresh (Ctrl/Cmd+Shift+R)
// or clear the site's Service Worker/cache in devtools rather than
// assuming the deploy failed.
//
// This is INDEPENDENT of CACHE_NAME in sw.js (the cache-busting version
// for the service worker's asset cache). The two live in different files
// and do NOT sync automatically — bump both together by hand on every
// deploy. See the matching comment above CACHE_NAME in sw.js.
// ---------------------------------------------------------------------
const APP_VERSION = '1.8';
const APP_VERSION_DATE = '2026-08-08';

// Populate the badge as soon as this script runs — deliberately not inside
// the DOMContentLoaded handler further down, so it appears immediately and
// doesn't wait on FleetApp initializing or the user unlocking the app.
// app.js loads with `defer`, so the DOM is already parsed by this point.
(() => {
  const badge = document.getElementById('versionBadge');
  if (badge) {
    badge.textContent = 'v' + APP_VERSION;
    badge.title = 'FleetLog v' + APP_VERSION + ' — ' + APP_VERSION_DATE;
  }
})();

class CryptoEngine {
  static async deriveKey(passcode, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(passcode), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  static async encrypt(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encodedData = enc.encode(JSON.stringify(data));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encodedData
    );
    return {
      iv: Array.from(iv),
      cipherText: Array.from(new Uint8Array(encrypted))
    };
  }

  static async decrypt(encryptedPayload, key) {
    const iv = new Uint8Array(encryptedPayload.iv);
    const cipherText = new Uint8Array(encryptedPayload.cipherText);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipherText
    );
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  }
}

class FleetApp {
  constructor() {
    this.db = null;
    this.vehicles = [];
    this.entries = [];
    this.currentVehicleId = null;
    this.sortField = 'date';
    this.sortAsc = false;
    this.pendingDelete = null;
    this.tempAttachment = null;
    this.tempVehicleAttachment = null;
    this.currencySymbol = 'RM';

    // Object URLs for the small inline image thumbnails shown next to
    // maintenance entries / vehicle details when their attachment is an
    // image ("logo"). Keyed by entry/vehicle id, revoked and rebuilt
    // whenever entries/vehicles are reloaded — see revokeThumbCache().
    this.entryThumbUrls = new Map();
    this.vehicleThumbUrls = new Map();
    // Object URLs created for whichever attachment is currently open in
    // the in-app viewer — revoked on close/replace, see closeAttachmentViewer().
    this.avObjectUrls = [];
    
    this.cryptoKey = null;
    this.salt = null;
    this.isSetup = false;
    this.biometricRecord = null;
  }

  async init() {
    try {
      await this.openDB();
      await this.loadCurrency();
      await this.checkAuthStatus();
    } catch (err) {
      alert('Initialization error: ' + err.message);
      console.error(err);
    }
  }

  openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('vehicles')) {
          db.createObjectStore('vehicles', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('entries')) {
          const store = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
          store.createIndex('vehicleId', 'vehicleId', { unique: false });
          store.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'key' });
        }
      };
    });
  }

  async checkAuthStatus() {
    const tx = this.db.transaction('config', 'readonly');
    const store = tx.objectStore('config');
    const authReq = store.get('auth');
    const bioReq = store.get('biometric');

    authReq.onsuccess = () => {
      const res = authReq.result;
      if (res) {
        this.isSetup = true;
        this.salt = new Uint8Array(res.salt);
        document.getElementById('lockTitle').textContent = 'Welcome Back';
        document.getElementById('lockSubtitle').textContent = 'Enter passcode to unlock encrypted data store.';
        document.getElementById('authSubmitBtn').textContent = 'Unlock App';
      } else {
        this.isSetup = false;
        document.getElementById('lockTitle').textContent = 'Create Passcode';
        document.getElementById('lockSubtitle').textContent = 'Set up a passcode to secure all app data with AES-256 encryption.';
        document.getElementById('authSubmitBtn').textContent = 'Set Passcode & Initialize';
      }
      document.getElementById('lockScreen').classList.remove('hidden');
    };

    bioReq.onsuccess = () => {
      this.biometricRecord = bioReq.result || null;
      this.showBiometricUnlockButton();
    };
  }

  isBiometricPlatformSupported() {
    return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  }

  showBiometricUnlockButton() {
    const bioBtn = document.getElementById('biometricUnlockBtn');
    if (!bioBtn) return;
    if (this.biometricRecord && this.isBiometricPlatformSupported()) {
      bioBtn.classList.remove('hidden');
      bioBtn.classList.add('flex');
    } else {
      bioBtn.classList.add('hidden');
      bioBtn.classList.remove('flex');
    }
  }

  refreshBiometricToggle() {
    const toggleBtn = document.getElementById('biometricToggleBtn');
    if (!toggleBtn) return;
    if (this.isBiometricPlatformSupported()) {
      toggleBtn.classList.remove('hidden');
      toggleBtn.classList.toggle('text-amber-400', !!this.biometricRecord);
      toggleBtn.title = this.biometricRecord ? 'Disable Fingerprint / Face ID Unlock' : 'Enable Fingerprint / Face ID Unlock';
    } else {
      toggleBtn.classList.add('hidden');
    }
  }

  bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  base64ToBuf(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async enrollBiometric() {
    if (!this.cryptoKey) { this.toast('Unlock the app first', 'error'); return; }
    if (!this.isBiometricPlatformSupported()) {
      this.toast('Fingerprint / Face ID unlock is not supported on this device or browser', 'error');
      return;
    }
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'FleetLog' },
          user: { id: userId, name: 'fleetlog-user', displayName: 'FleetLog User' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', requireResidentKey: false },
          timeout: 60000,
          attestation: 'none'
        }
      });
      if (!credential) throw new Error('Enrollment cancelled');

      // Export the active encryption key and wrap it behind a random device-local
      // key. The fingerprint/Face ID prompt gates access to it on future unlocks.
      const rawKey = await crypto.subtle.exportKey('raw', this.cryptoKey);
      const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey);
      const rawWrappingKey = await crypto.subtle.exportKey('raw', wrappingKey);

      const record = {
        key: 'biometric',
        credentialId: this.bufToBase64(credential.rawId),
        wrappingKey: this.bufToBase64(rawWrappingKey),
        iv: Array.from(iv),
        wrappedKey: this.bufToBase64(wrappedKey)
      };

      const tx = this.db.transaction('config', 'readwrite');
      tx.objectStore('config').put(record);
      await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });

      this.biometricRecord = record;
      this.refreshBiometricToggle();
      this.toast('Fingerprint / Face ID unlock enabled');
    } catch (err) {
      this.toast('Could not enable biometric unlock: ' + err.message, 'error');
    }
  }

  async disableBiometric() {
    try {
      const tx = this.db.transaction('config', 'readwrite');
      tx.objectStore('config').delete('biometric');
      await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
      this.biometricRecord = null;
      this.refreshBiometricToggle();
      this.toast('Fingerprint / Face ID unlock disabled');
    } catch (err) {
      this.toast('Could not disable biometric unlock: ' + err.message, 'error');
    }
  }

  async toggleBiometric() {
    if (this.biometricRecord) {
      if (confirm('Disable Fingerprint / Face ID unlock on this device?')) {
        await this.disableBiometric();
      }
    } else {
      await this.enrollBiometric();
    }
  }

  async unlockWithBiometric() {
    if (!this.biometricRecord) return;
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: this.base64ToBuf(this.biometricRecord.credentialId), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      if (!assertion) throw new Error('Authentication cancelled');

      const wrappingKey = await crypto.subtle.importKey('raw', this.base64ToBuf(this.biometricRecord.wrappingKey), { name: 'AES-GCM' }, false, ['decrypt']);
      const iv = new Uint8Array(this.biometricRecord.iv);
      const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, this.base64ToBuf(this.biometricRecord.wrappedKey));
      const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

      const tx = this.db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('auth');
      const authRecord = await new Promise((r, j) => { req.onsuccess = () => r(req.result); req.onerror = j; });
      const verified = await CryptoEngine.decrypt(authRecord.verifier, cryptoKey);
      if (verified.check !== 'FLEETLOG_VALID') throw new Error('Key mismatch');

      this.cryptoKey = cryptoKey;
      this.unlockApp();
    } catch (err) {
      this.toast('Biometric unlock failed: ' + err.message, 'error');
    }
  }

  async handleAuthSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('passcodeInput');
    const passcode = input.value;
    if (!passcode) return;

    try {
      if (!this.isSetup) {
        this.salt = crypto.getRandomValues(new Uint8Array(16));
        this.cryptoKey = await CryptoEngine.deriveKey(passcode, this.salt);
        const verifier = await CryptoEngine.encrypt({ check: "FLEETLOG_VALID" }, this.cryptoKey);
        
        const tx = this.db.transaction('config', 'readwrite');
        tx.objectStore('config').put({
          key: 'auth',
          salt: Array.from(this.salt),
          verifier
        });
        await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
        this.isSetup = true;
        this.unlockApp();
      } else {
        this.cryptoKey = await CryptoEngine.deriveKey(passcode, this.salt);
        const tx = this.db.transaction('config', 'readonly');
        const req = tx.objectStore('config').get('auth');
        const authRecord = await new Promise((r, j) => { req.onsuccess = () => r(req.result); req.onerror = j; });
        
        try {
          const verified = await CryptoEngine.decrypt(authRecord.verifier, this.cryptoKey);
          if (verified.check === "FLEETLOG_VALID") {
            this.unlockApp();
          } else {
            throw new Error();
          }
        } catch (err) {
          alert('Incorrect Passcode');
          input.value = '';
        }
      }
    } catch (err) {
      alert('Authentication error: ' + err.message);
    }
  }

  async unlockApp() {
    document.getElementById('lockScreen').classList.add('hidden');
    document.getElementById('appContainer').classList.remove('hidden');
    document.getElementById('passcodeInput').value = '';
    this.refreshBiometricToggle();

    await this.loadVehicles();
    if (this.vehicles.length > 0) {
      await this.selectVehicle(this.vehicles[0].id);
    } else {
      this.renderEmpty();
    }
    document.getElementById('printDate').textContent = this.formatDisplayDate(this.localDateStr());
  }

  lockApp() {
    this.cryptoKey = null;
    this.vehicles = [];
    this.entries = [];
    document.getElementById('appContainer').classList.add('hidden');
    document.getElementById('lockScreen').classList.remove('hidden');
    this.showBiometricUnlockButton();
  }

  async loadVehicles() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readonly');
      const store = tx.objectStore('vehicles');
      const req = store.getAll();
      req.onsuccess = async () => {
        try {
          const rawVehicles = req.result;
          this.vehicles = [];
          // Attachments are re-decrypted into fresh Blob objects on every
          // load, so any thumbnail object URLs from the previous set are
          // now pointing at orphaned Blobs — revoke them before rebuilding.
          this.revokeThumbCache(this.vehicleThumbUrls);
          for (const raw of rawVehicles) {
            if (raw.payload) {
              const decrypted = await CryptoEngine.decrypt(raw.payload, this.cryptoKey);
              if (decrypted.attachment && typeof decrypted.attachment === 'string') {
                decrypted.attachment = this.base64ToBlob(decrypted.attachment, decrypted.attachmentType);
              }
              this.vehicles.push({ id: raw.id, ...decrypted });
            } else {
              this.vehicles.push(raw);
            }
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async loadEntries(vehicleId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('entries', 'readonly');
      const store = tx.objectStore('entries');
      const idx = store.index('vehicleId');
      const req = idx.getAll(vehicleId);
      req.onsuccess = async () => {
        try {
          const rawEntries = req.result;
          this.entries = [];
          // Same reasoning as in loadVehicles(): fresh Blobs every load,
          // so the previous batch of thumbnail object URLs is now stale.
          this.revokeThumbCache(this.entryThumbUrls);
          for (const raw of rawEntries) {
            if (raw.payload) {
              const decrypted = await CryptoEngine.decrypt(raw.payload, this.cryptoKey);
              if (decrypted.attachment && typeof decrypted.attachment === 'string') {
                decrypted.attachment = this.base64ToBlob(decrypted.attachment, decrypted.attachmentType);
              }
              this.entries.push({ id: raw.id, vehicleId: raw.vehicleId, ...decrypted });
            } else {
              this.entries.push(raw);
            }
          }
          this.sortEntries();
          this.updateSupplierDatalist();
          this.updateCustomExpenseDatalist();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  updateSupplierDatalist() {
    const list = document.getElementById('supplierList');
    const suppliers = new Set();
    this.entries.forEach(e => { if (e.supplier) suppliers.add(e.supplier.trim()); });
    list.innerHTML = Array.from(suppliers).map(s => `<option value="${this.escape(s)}"></option>`).join('');
  }

  updateCustomExpenseDatalist() {
    const list = document.getElementById('customExpenseList');
    const defaults = ['Summons', 'Parking', 'Toll', 'Insurance', 'Road Tax', 'Fuel'];
    const names = new Set(defaults);
    this.entries.forEach(e => {
      if (e.categoryName && e.categoryName.trim()) {
        names.add(e.categoryName.trim());
      }
    });
    list.innerHTML = Array.from(names).map(n => `<option value="${this.escape(n)}"></option>`).join('');
  }

  sortEntries() {
    this.entries.sort((a, b) => {
      let va, vb;
      if (this.sortField === 'date') {
        va = a.date ? new Date(a.date).getTime() : 0;
        vb = b.date ? new Date(b.date).getTime() : 0;
      } else {
        va = a[this.sortField] || 0;
        vb = b[this.sortField] || 0;
      }
      return this.sortAsc ? va - vb : vb - va;
    });
  }

  sortBy(field) {
    if (this.sortField === field) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortField = field;
      this.sortAsc = false;
    }
    this.sortEntries();
    this.renderEntries();
  }

  async selectVehicle(id) {
    this.currentVehicleId = id;
    await this.loadEntries(id);
    this.renderVehicleSelector();
    this.renderDashboard();
    this.renderEntries();
    this.renderVehicleInfo();
    this.renderPrintSections();
  }

  renderVehicleSelector() {
    const container = document.getElementById('vehicleSelector');
    if (this.vehicles.length === 0) {
      container.innerHTML = '<div class="text-gray-400 text-sm py-2">No vehicles yet. Click "Add Vehicle" to start.</div>';
      return;
    }
    container.innerHTML = this.vehicles.map(v => {
      const isActive = v.id === this.currentVehicleId;
      const dutyBadge = v.dutyStatus === 'duty_free'
        ? `<span class="absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-emerald-500 text-white shadow-sm border border-white rotate-6 select-none">Duty Free</span>`
        : v.dutyStatus === 'duty_paid'
        ? `<span class="absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-blue-600 text-white shadow-sm border border-white rotate-6 select-none">Duty Paid</span>`
        : '';
      return `
        <button data-click="selectVehicle" data-click-args='[${v.id}]' data-mouseenter="showVehicleTooltip" data-mouseenter-args='["@event", ${v.id}]' data-mouseleave="hideVehicleTooltip"
          class="relative flex-shrink-0 snap-start px-4 py-3 rounded-xl border-2 transition-all text-left ${isActive
            ? 'border-amber-500 bg-amber-50 text-slate-900 shadow-md'
            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:shadow-sm'}">
          ${dutyBadge}
          <div class="font-semibold text-sm">${this.escape(v.name) || 'Unnamed'}</div>
          <div class="text-xs opacity-70">${this.escape(v.reg) || 'No Reg'}</div>
        </button>
      `;
    }).join('');
  }

  showVehicleTooltip(evt, vehicleId) {
    const v = this.vehicles.find(x => x.id === vehicleId);
    if (!v) return;

    const lines = [];
    if (v.initialValueBreakdown && v.initialValueBreakdown.length > 0) {
      lines.push('<div class="font-semibold text-amber-300 mb-1">Initial Value Breakdown</div>');
      v.initialValueBreakdown.forEach(item => {
        if (item.label || item.amount || item.date) {
          const formattedDate = this.formatDisplayDate(item.date);
          const itemText = [formattedDate !== '-' ? formattedDate : '', item.label].filter(Boolean).join(' - ');
          lines.push(`<div class="flex justify-between gap-3 text-slate-200"><span>${this.escape(itemText || 'Item')}:</span><span class="font-medium text-white">${this.cur()}${this.fmt(item.amount || 0)}</span></div>`);
        }
      });
    }
    if (v.notes) {
      if (lines.length) lines.push('<div class="border-t border-slate-600 my-1.5"></div>');
      lines.push('<div class="font-semibold text-amber-300 mb-1">Notes</div>');
      v.notes.split('\n').forEach(line => {
        if (line.trim()) lines.push(`<div class="text-slate-200">• ${this.escape(line.trim())}</div>`);
      });
    }
    if (lines.length === 0) return;

    const tip = document.getElementById('vehicleTooltip');
    tip.innerHTML = lines.join('');
    tip.classList.remove('hidden');

    const rect = evt.currentTarget.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
    if (left < 8) left = 8;
    if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 8;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  hideVehicleTooltip() {
    const tip = document.getElementById('vehicleTooltip');
    if (tip) tip.classList.add('hidden');
  }

  renderDashboard() {
    const vehicle = this.vehicles.find(v => v.id === this.currentVehicleId);
    const container = document.getElementById('dashboard');
    if (!vehicle) { container.innerHTML = ''; return; }

    document.getElementById('printVehicleName').textContent = `${vehicle.name || ''} (${vehicle.reg || 'No Reg'})`;

    const totalCost = this.entries.filter(e => e.type === 'maintenance').reduce((s, e) => s + (parseFloat(e.cost) || 0), 0);
    const totalPart = this.entries.reduce((s, e) => s + (parseFloat(e.part) || 0), 0);
    const totalService = this.entries.reduce((s, e) => s + (parseFloat(e.service) || 0), 0);
    const totalDepreciation = this.entries.reduce((s, e) => s + (parseFloat(e.depreciation) || 0), 0);

    const customCategoryTotals = {};
    this.entries.forEach(e => {
      if (e.type === 'other') {
        const catName = (e.categoryName && e.categoryName.trim()) ? e.categoryName.trim() : 'Other';
        customCategoryTotals[catName] = (customCategoryTotals[catName] || 0) + (parseFloat(e.cost) || 0);
      }
    });

    const totalCustomCosts = Object.values(customCategoryTotals).reduce((a, b) => a + b, 0);
    const totalSpent = totalCost + totalPart + totalService + totalCustomCosts;

    let breakdownItems = [];
    if (totalCost > 0) breakdownItems.push(`<div class="flex justify-between items-center"><span>Cost:</span> <span class="font-medium text-slate-700">${this.cur()}${this.fmt(totalCost)}</span></div>`);
    if (totalPart > 0) breakdownItems.push(`<div class="flex justify-between items-center"><span>Part:</span> <span class="font-medium text-slate-700">${this.cur()}${this.fmt(totalPart)}</span></div>`);
    if (totalService > 0) breakdownItems.push(`<div class="flex justify-between items-center"><span>Service:</span> <span class="font-medium text-slate-700">${this.cur()}${this.fmt(totalService)}</span></div>`);
    
    Object.keys(customCategoryTotals).forEach(cat => {
      breakdownItems.push(`<div class="flex justify-between items-center"><span>${this.escape(cat)}:</span> <span class="font-medium text-slate-700">${this.cur()}${this.fmt(customCategoryTotals[cat])}</span></div>`);
    });

    const breakdownHTML = breakdownItems.length > 0 
      ? `<div class="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">${breakdownItems.join('')}</div>` 
      : `<div class="text-xs text-gray-400 mt-1">No expenses recorded</div>`;

    const lastKm = this.entries.reduce((max, e) => {
      const k = parseFloat(e.km);
      return !isNaN(k) && k > max ? k : max;
    }, 0);
    const bookValue = (vehicle.initialValue || 0) - totalDepreciation;

    container.innerHTML = `
      <div class="dash-card bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
        <div class="text-xs text-gray-500 uppercase font-semibold mb-1">Current Book Value</div>
        <div class="text-2xl font-bold text-slate-800">${this.cur()}${this.fmt(bookValue)}</div>
        <div class="text-xs text-gray-400 mt-1">Initial Value: ${this.cur()}${this.fmt(vehicle.initialValue || 0)}</div>
      </div>
      <div class="dash-card bg-white rounded-xl p-5 border border-gray-200 shadow-sm flex flex-col justify-between">
        <div>
          <div class="text-xs text-gray-500 uppercase font-semibold mb-1">Total Spent</div>
          <div class="text-2xl font-bold text-emerald-600">${this.cur()}${this.fmt(totalSpent)}</div>
        </div>
        ${breakdownHTML}
      </div>
      <div class="dash-card bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
        <div class="text-xs text-gray-500 uppercase font-semibold mb-1">Depreciation</div>
        <div class="text-2xl font-bold text-blue-600">${this.cur()}${this.fmt(totalDepreciation)}</div>
        <div class="text-xs text-gray-400 mt-1">Total written off</div>
      </div>
      <div class="dash-card bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
        <div class="text-xs text-gray-500 uppercase font-semibold mb-1">Last Odometer</div>
        <div class="text-2xl font-bold text-slate-800">${this.fmt(lastKm, 0)} <span class="text-sm font-normal text-gray-400">km</span></div>
        <div class="text-xs text-gray-400 mt-1">${this.entries.length} entries</div>
      </div>
    `;
  }

  formatParticulars(text) {
    if (!text) return '—';
    const items = text.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    if (items.length <= 1) return this.escape(text);
    return items.map(i => `<div>• ${this.escape(i)}</div>`).join('');
  }

  buildBreakdown(e) {
    const items = [];
    const costLabel = (e.type === 'other' && e.categoryName && e.categoryName.trim()) 
      ? e.categoryName.trim() 
      : (e.type === 'bank_loan' ? 'Installment' : 'Cost');
      
    if (e.cost != null) items.push({ label: costLabel, value: e.cost, cls: 'text-slate-800 font-semibold' });
    if (e.part != null) items.push({ label: 'Part', value: e.part, cls: 'text-slate-700' });
    if (e.service != null) items.push({ label: 'Service', value: e.service, cls: 'text-slate-700' });
    if (e.depreciation != null) items.push({ label: 'Depr.', value: e.depreciation, cls: 'text-blue-600 font-medium' });

    if (items.length === 0) return '<span class="text-gray-300 text-xs">—</span>';
    return `<div class="space-y-0.5">${items.map(i => `
      <div class="flex justify-between items-baseline gap-3 text-xs">
        <span class="text-gray-500">${this.escape(i.label)}:</span>
        <span class="${i.cls} font-mono">${this.cur()}${this.fmt(i.value)}</span>
      </div>`).join('')}</div>`;
  }

  renderEntries() {
    const tbody = document.getElementById('entriesTable');
    const empty = document.getElementById('emptyState');
    const count = document.getElementById('entryCount');

    count.textContent = this.entries.length + ' entries';

    if (this.entries.length === 0) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const chronoKm = this.entries
      .filter(e => e.type === 'maintenance' && e.service != null && e.km != null && e.km !== '' && !isNaN(parseFloat(e.km)))
      .slice()
      .sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        if (da !== db) return da - db;
        return (a.id || 0) - (b.id || 0);
      });
    const prevKmById = new Map();
    for (let i = 1; i < chronoKm.length; i++) {
      prevKmById.set(chronoKm[i].id, parseFloat(chronoKm[i - 1].km));
    }

    tbody.innerHTML = this.entries.map(e => {
      const dateStr = this.formatDisplayDate(e.date);
      
      let typeBadge = { color: 'text-emerald-600 bg-emerald-50', label: 'MAINT' };
      if (e.type === 'depreciation') {
        typeBadge = { color: 'text-blue-600 bg-blue-50', label: 'DEPR' };
      } else if (e.type === 'bank_loan') {
        typeBadge = { color: 'text-indigo-600 bg-indigo-50', label: 'BANK LOAN' };
      } else if (e.type === 'other' || (e.categoryName && e.categoryName.trim())) {
        const rawLabel = (e.categoryName && e.categoryName.trim()) ? e.categoryName.trim().toUpperCase() : 'OTHER';
        if (rawLabel === 'SUMMONS' || rawLabel === 'SUMMON') {
          typeBadge = { color: 'text-red-600 bg-red-50', label: 'SUMMONS' };
        } else {
          typeBadge = { color: 'text-purple-600 bg-purple-50', label: this.escape(rawLabel) };
        }
      }

      return `
        <tr class="hover:bg-gray-50 transition group fade-in">
          <td class="px-3 py-2.5 align-top whitespace-nowrap">
            <div class="font-medium text-slate-800 text-xs">${dateStr}</div>
            <span class="inline-block mt-0.5 px-1.5 py-0.5 text-[9px] font-bold rounded ${typeBadge.color}">${typeBadge.label}</span>
          </td>
          <td class="px-3 py-2.5 text-slate-700 font-mono text-xs align-top whitespace-nowrap">
            ${e.km != null ? this.fmt(e.km, 0) : '—'}
            ${(() => {
              if (e.type !== 'maintenance' || e.service == null || e.km == null || !prevKmById.has(e.id)) return '';
              const diff = parseFloat(e.km) - prevKmById.get(e.id);
              if (isNaN(diff)) return '';
              return `<div class="text-[9px] text-gray-400 font-sans mt-0.5">${diff >= 0 ? '+' : ''}${this.fmt(diff, 0)} km</div>`;
            })()}
          </td>
          <td class="px-3 py-2.5 align-top whitespace-nowrap">
            <div class="text-slate-800 font-medium text-xs">${this.escape(e.supplier || '—')}</div>
          </td>
          <td class="px-3 py-2.5 align-top">
            <div class="particulars-text text-gray-600" title="${this.escape(e.particulars || '')}">${this.formatParticulars(e.particulars)}</div>
          </td>
          <td class="px-3 py-2.5 align-top">
            <div class="breakdown-text">${this.buildBreakdown(e)}</div>
          </td>
          <td class="print-col-actions px-2 py-2.5 text-center no-print align-top whitespace-nowrap">
            <div class="flex justify-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition">
              <button data-click="editEntry" data-click-args='[${e.id}]' class="p-1 text-amber-600 hover:bg-amber-50 rounded transition" title="Edit">✏️</button>
              <button data-click="confirmDeleteEntry" data-click-args='[${e.id}]' class="p-1 text-red-600 hover:bg-red-50 rounded transition" title="Delete">🗑️</button>
            </div>
          </td>
        </tr>${e.attachmentName ? `
        <tr class="bg-slate-50/70">
          <td colspan="6" class="px-3 pb-2 pt-0">
            <button data-click="openEntryAttachment" data-click-args='[${e.id}]' class="ml-0 sm:ml-[19%] inline-flex items-center gap-1.5 text-[11px] text-blue-600 hover:text-blue-800 hover:underline">
              ${e.attachmentType && e.attachmentType.startsWith('image/') && e.attachment
                ? `<img src="${this.getThumbUrl(this.entryThumbUrls, e.id, e.attachment)}" class="w-6 h-6 object-cover rounded border border-gray-300 flex-shrink-0" alt="">`
                : '📎'}
              <span class="truncate max-w-[260px]">${this.escape(e.attachmentName)}</span>
            </button>
          </td>
        </tr>` : ''}
      `;
    }).join('');
  }

  renderVehicleInfo() {
    const v = this.vehicles.find(x => x.id === this.currentVehicleId);
    const el = document.getElementById('vehicleDetailContent');
    const footer = document.getElementById('vehicleInfoFooter');
    if (!v) { 
      el.innerHTML = ''; 
      footer.classList.add('hidden');
      return; 
    }
    footer.classList.remove('hidden');
    el.innerHTML = `
      <p><span class="font-medium text-slate-700">Year:</span> ${this.escape(v.year) || '—'}</p>
      ${v.attachmentName ? `<p><button data-click="openVehicleAttachment" data-click-args='[${v.id}]' class="inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-800 hover:underline no-print">
        ${v.attachmentType && v.attachmentType.startsWith('image/') && v.attachment
          ? `<img src="${this.getThumbUrl(this.vehicleThumbUrls, v.id, v.attachment)}" class="w-6 h-6 object-cover rounded border border-gray-300 flex-shrink-0" alt="">`
          : '📎'}
        <span>${this.escape(v.attachmentName)}</span>
      </button></p>` : ''}
      ${v.notes ? `<div class="mt-1"><span class="font-medium text-slate-700">Notes:</span><div class="mt-1 space-y-0.5 text-gray-600">${v.notes.split('\n').map(line => line.trim() ? `<p class="leading-relaxed">${this.escape(line)}</p>` : '').join('')}</div></div>` : ''}
    `;
  }

  renderPrintSections() {
    const v = this.vehicles.find(x => x.id === this.currentVehicleId);
    if (!v) return;

    const printBankLoanSection = document.getElementById('printBankLoanSection');
    const printBankLoanTable = document.getElementById('printBankLoanTable');
    const loanEntries = this.entries.filter(e => e.type === 'bank_loan');

    if (loanEntries.length > 0) {
      printBankLoanSection.classList.remove('hidden');
      const totalPaid = loanEntries.reduce((s, e) => s + (parseFloat(e.cost) || 0), 0);
      printBankLoanTable.innerHTML = loanEntries.map(e => `
        <tr>
          <td class="border border-gray-300 px-2 py-1">${this.formatDisplayDate(e.date)}</td>
          <td class="border border-gray-300 px-2 py-1 font-medium">${this.escape(e.supplier || 'Bank Loan')}</td>
          <td class="border border-gray-300 px-2 py-1">${this.escape(e.particulars || '-')}</td>
          <td class="border border-gray-300 px-2 py-1 text-right font-mono">${this.cur()}${this.fmt(e.cost)}</td>
        </tr>
      `).join('') + `
        <tr class="font-bold bg-slate-50">
          <td colspan="3" class="border border-gray-300 px-2 py-1 text-right">Total Paid:</td>
          <td class="border border-gray-300 px-2 py-1 text-right font-mono text-blue-700">${this.cur()}${this.fmt(totalPaid)}</td>
        </tr>
      `;
    } else {
      printBankLoanSection.classList.add('hidden');
    }

    const printInitialValueTable = document.getElementById('printInitialValueTable');
    if (v.initialValueBreakdown && v.initialValueBreakdown.length > 0) {
      printInitialValueTable.innerHTML = v.initialValueBreakdown.map(i => `
        <tr>
          <td class="border border-gray-300 px-2 py-1">${this.formatDisplayDate(i.date)}</td>
          <td class="border border-gray-300 px-2 py-1">${this.escape(i.label || 'Item')}</td>
          <td class="border border-gray-300 px-2 py-1 text-right font-mono">${this.cur()}${this.fmt(i.amount)}</td>
        </tr>
      `).join('') + `
        <tr class="font-bold bg-slate-50">
          <td colspan="2" class="border border-gray-300 px-2 py-1 text-right">Total Initial Value:</td>
          <td class="border border-gray-300 px-2 py-1 text-right font-mono">${this.cur()}${this.fmt(v.initialValue)}</td>
        </tr>
      `;
    } else {
      printInitialValueTable.innerHTML = `
        <tr>
          <td class="border border-gray-300 px-2 py-1">-</td>
          <td class="border border-gray-300 px-2 py-1">Initial Vehicle Value</td>
          <td class="border border-gray-300 px-2 py-1 text-right font-mono">${this.cur()}${this.fmt(v.initialValue)}</td>
        </tr>
      `;
    }
  }

  renderEmpty() {
    document.getElementById('vehicleSelector').innerHTML = '<div class="text-gray-400 text-sm py-2">No vehicles yet. Click "Add Vehicle" to start.</div>';
    document.getElementById('dashboard').innerHTML = '';
    document.getElementById('entriesTable').innerHTML = '';
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('vehicleInfoFooter').classList.add('hidden');
  }

  addInitialValueRow(date = '', label = '', amount = '') {
    const wrap = document.getElementById('initialValueRows');
    const row = document.createElement('div');
    row.className = 'grid grid-cols-12 gap-2 items-center';
    row.innerHTML = `
      <input type="date" class="col-span-3 px-2 py-1.5 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none" value="${this.escape(date)}" data-input="updateInitialValueTotal">
      <input type="text" class="col-span-5 px-2 py-1.5 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none" placeholder="Particulars (Deposit, Bank Loan...)" value="${this.escape(label)}" data-input="updateInitialValueTotal">
      <input type="number" step="0.01" class="col-span-3 px-2 py-1.5 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none" placeholder="Amount (0.00)" value="${this.escape(amount !== '' ? amount : '')}" data-input="updateInitialValueTotal">
      <button type="button" data-click="removeInitialValueRow" data-click-args='["@this"]' class="col-span-1 text-red-400 hover:text-red-600 px-1 text-sm text-center" title="Remove">✕</button>
    `;
    wrap.appendChild(row);
    this.updateInitialValueTotal();
  }

  removeInitialValueRow(btn) {
    const wrap = document.getElementById('initialValueRows');
    btn.closest('div').remove();
    if (wrap.children.length === 0) this.addInitialValueRow();
    this.updateInitialValueTotal();
  }

  collectInitialValueBreakdown() {
    const rows = document.querySelectorAll('#initialValueRows > div');
    const items = [];
    rows.forEach(row => {
      const inputs = row.querySelectorAll('input');
      const date = inputs[0].value;
      const label = inputs[1].value.trim();
      const amount = parseFloat(inputs[2].value) || 0;
      if (date || label || amount) items.push({ date, label, amount });
    });
    return items;
  }

  updateInitialValueTotal() {
    const total = this.collectInitialValueBreakdown().reduce((s, i) => s + (i.amount || 0), 0);
    document.getElementById('initialValueTotal').textContent = this.currencySymbol + ' ' + this.fmt(total);
    return total;
  }

  showBankLoanLedger() {
    const v = this.vehicles.find(x => x.id === this.currentVehicleId);
    if (!v) return;
    document.getElementById('bankLoanVehicleTitle').textContent = `${v.name} (${v.reg || 'No Reg'})`;
    document.getElementById('loanDate').value = this.localDateStr();
    document.getElementById('loanBank').value = '';
    document.getElementById('loanAmount').value = '';
    document.getElementById('loanParticulars').value = '';
    document.getElementById('loanTxId').value = '';
    
    this.renderBankLoanLedger();
    this.openModal('bankLoanModal');
  }

  async saveLoanTransaction() {
    const date = document.getElementById('loanDate').value;
    const bank = document.getElementById('loanBank').value.trim();
    const amount = parseFloat(document.getElementById('loanAmount').value);
    const particulars = document.getElementById('loanParticulars').value.trim();

    if (!amount || isNaN(amount)) {
      this.toast('Please enter a valid loan installment amount', 'error');
      return;
    }

    const data = {
      type: 'bank_loan',
      categoryName: 'Bank Loan',
      date: date,
      supplier: bank || 'Bank Loan',
      particulars: particulars || 'Loan Payment Transaction',
      cost: amount
    };

    const encrypted = await CryptoEngine.encrypt(data, this.cryptoKey);
    const record = { vehicleId: this.currentVehicleId, payload: encrypted };

    const tx = this.db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    await new Promise((r, j) => {
      const q = store.add(record);
      q.onsuccess = () => r();
      q.onerror = () => j(q.error);
      tx.onerror = () => j(tx.error);
    });

    document.getElementById('loanAmount').value = '';
    document.getElementById('loanParticulars').value = '';
    
    await this.loadEntries(this.currentVehicleId);
    this.renderDashboard();
    this.renderEntries();
    this.renderBankLoanLedger();
    this.renderPrintSections();
    this.toast('Loan payment recorded');
  }

  renderBankLoanLedger() {
    const table = document.getElementById('loanLedgerTable');
    const loanEntries = this.entries.filter(e => e.type === 'bank_loan');
    const totalPaid = loanEntries.reduce((s, e) => s + (parseFloat(e.cost) || 0), 0);
    
    document.getElementById('loanTotalPaid').textContent = `Total Paid: ${this.cur()}${this.fmt(totalPaid)}`;

    if (loanEntries.length === 0) {
      table.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-gray-400">No bank loan transactions recorded yet.</td></tr>`;
      return;
    }

    table.innerHTML = loanEntries.map(e => `
      <tr class="hover:bg-slate-50">
        <td class="p-2.5 whitespace-nowrap">${this.formatDisplayDate(e.date)}</td>
        <td class="p-2.5 font-medium text-slate-800">${this.escape(e.supplier || 'Bank Loan')}</td>
        <td class="p-2.5 text-gray-600">${this.escape(e.particulars || '-')}</td>
        <td class="p-2.5 font-mono text-right font-semibold text-slate-800">${this.cur()}${this.fmt(e.cost)}</td>
        <td class="p-2.5 text-center">
          <button data-click="deleteLoanTx" data-click-args='[${e.id}]' class="text-red-500 hover:text-red-700" title="Delete record">🗑️</button>
        </td>
      </tr>
    `).join('');
  }

  async deleteLoanTx(id) {
    if (!confirm('Delete this loan payment transaction?')) return;
    const tx = this.db.transaction('entries', 'readwrite');
    tx.objectStore('entries').delete(id);
    await new Promise((r, j) => {
      tx.oncomplete = () => r();
      tx.onerror = () => j(tx.error);
    });
    await this.loadEntries(this.currentVehicleId);
    this.renderDashboard();
    this.renderEntries();
    this.renderBankLoanLedger();
    this.renderPrintSections();
    this.toast('Transaction deleted');
  }

  showAddVehicle() {
    this.clearVehicleAttachment();
    document.getElementById('vehicleId').value = '';
    document.getElementById('vehicleName').value = '';
    document.getElementById('vehicleReg').value = '';
    document.getElementById('vehicleYear').value = '';
    document.getElementById('vehicleDutyStatus').value = '';
    document.getElementById('vehicleNotes').value = '';
    document.getElementById('initialValueRows').innerHTML = '';
    this.addInitialValueRow();
    document.getElementById('vehicleModalTitle').textContent = 'Add Vehicle';
    this.openModal('vehicleModal');
  }

  editVehicle() {
    const v = this.vehicles.find(x => x.id === this.currentVehicleId);
    if (!v) return;
    this.clearVehicleAttachment();
    document.getElementById('vehicleId').value = v.id;
    document.getElementById('vehicleName').value = v.name || '';
    document.getElementById('vehicleReg').value = v.reg || '';
    document.getElementById('vehicleYear').value = v.year || '';
    document.getElementById('vehicleDutyStatus').value = v.dutyStatus || '';
    document.getElementById('vehicleNotes').value = v.notes || '';
    document.getElementById('initialValueRows').innerHTML = '';
    
    if (v.initialValueBreakdown && v.initialValueBreakdown.length > 0) {
      v.initialValueBreakdown.forEach(item => this.addInitialValueRow(item.date || '', item.label || '', item.amount || ''));
    } else {
      this.addInitialValueRow('', 'Initial Value', v.initialValue || '');
    }

    if (v.attachmentName) {
      document.getElementById('vehicleAttachmentLabel').textContent = '📎 ' + v.attachmentName;
      document.getElementById('vehicleAttachmentLabel').classList.add('text-amber-700', 'bg-amber-50', 'border-amber-300');
      document.getElementById('clearVehicleAttachmentBtn').classList.remove('hidden');
      document.getElementById('vehicleAttachmentName').textContent = 'Existing: ' + v.attachmentName + ' (upload new to replace)';
      document.getElementById('vehicleAttachmentName').classList.remove('hidden');
    }
    document.getElementById('vehicleModalTitle').textContent = 'Edit Vehicle';
    this.openModal('vehicleModal');
  }

  onVehicleFileSelected(input) {
    if (input.files.length > 0) {
      const file = input.files[0];
      if (!this.checkFileSize(file)) { input.value = ''; return; }
      this.tempVehicleAttachment = { blob: file, name: file.name, type: file.type };
      document.getElementById('vehicleAttachmentLabel').textContent = '📎 ' + file.name;
      document.getElementById('vehicleAttachmentLabel').classList.add('text-amber-700', 'bg-amber-50', 'border-amber-300');
      document.getElementById('clearVehicleAttachmentBtn').classList.remove('hidden');
      document.getElementById('vehicleAttachmentName').textContent = 'Ready to upload: ' + file.name;
      document.getElementById('vehicleAttachmentName').classList.remove('hidden');
    }
  }

  clearVehicleAttachment() {
    this.tempVehicleAttachment = null;
    document.getElementById('vehicleAttachment').value = '';
    document.getElementById('vehicleAttachmentLabel').textContent = '📎 Click to upload file';
    document.getElementById('vehicleAttachmentLabel').classList.remove('text-amber-700', 'bg-amber-50', 'border-amber-300');
    document.getElementById('clearVehicleAttachmentBtn').classList.add('hidden');
    document.getElementById('vehicleAttachmentName').classList.add('hidden');
  }

  // ==================== ATTACHMENT VIEWER (image/PDF) ====================
  // In-app viewer for vehicle cards/duty certs and maintenance-entry
  // attachments. Deliberately does NOT navigate to the Blob URL or embed
  // it in an iframe: navigating a link straight to a blob: URL makes most
  // browsers treat it as a download rather than something to view, and
  // iframes showing a PDF can render blank or get blocked outright
  // depending on the browser's own PDF-handling setting. Images are
  // shown via a Blob object URL; PDFs are decoded and rendered
  // page-by-page onto <canvas> via pdf.js. "Save a Copy" stays a
  // separate, explicit action for when a real download is wanted.

  getThumbUrl(map, id, blob) {
    const cached = map.get(id);
    if (cached && cached.blob === blob) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(blob);
    map.set(id, { blob, url });
    return url;
  }

  revokeThumbCache(map) {
    map.forEach(entry => URL.revokeObjectURL(entry.url));
    map.clear();
  }

  openEntryAttachment(entryId) {
    const entry = this.entries.find(e => e.id === entryId);
    if (!entry || !entry.attachment) { this.toast('No attachment found', 'error'); return; }
    this.openAttachmentViewer(entry.attachment, entry.attachmentName, entry.attachmentType);
  }

  openVehicleAttachment(vehicleId) {
    const vehicle = this.vehicles.find(v => v.id === vehicleId);
    if (!vehicle || !vehicle.attachment) { this.toast('No attachment found', 'error'); return; }
    this.openAttachmentViewer(vehicle.attachment, vehicle.attachmentName, vehicle.attachmentType);
  }

  async openAttachmentViewer(blob, name, type) {
    this.avObjectUrls.forEach(u => URL.revokeObjectURL(u));
    this.avObjectUrls = [];

    document.getElementById('avTitle').textContent = name || 'Attachment';
    const content = document.getElementById('avContent');
    content.innerHTML = '<div class="py-16 text-gray-400 text-sm">Loading…</div>';
    this.openModal('attachmentViewerModal');

    const fileUrl = URL.createObjectURL(blob);
    this.avObjectUrls.push(fileUrl);
    const saveBtn = document.getElementById('avSaveCopyBtn');
    saveBtn.href = fileUrl;
    saveBtn.setAttribute('download', name || 'attachment');

    const isImage = type && type.startsWith('image/');
    const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name || '');

    try {
      if (isImage) {
        content.innerHTML = '';
        const img = document.createElement('img');
        img.src = fileUrl;
        img.className = 'max-w-full mx-auto rounded-lg';
        content.appendChild(img);
      } else if (isPdf) {
        if (!window.pdfjsLib) throw new Error('PDF viewer failed to load');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        content.innerHTML = '';
        const containerWidth = content.clientWidth || 700;
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = Math.max(0.1, (containerWidth - 20) / unscaledViewport.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = 'mx-auto mb-3 shadow rounded bg-white block';
          content.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
      } else {
        content.innerHTML = '<div class="py-16 text-gray-400 text-sm">Preview not available for this file type — use "Save a Copy" to download it.</div>';
      }
    } catch (err) {
      content.innerHTML = '<div class="py-16 text-red-500 text-sm px-4">Could not preview this file: ' + this.escape(err.message) + '</div>';
    }
  }

  closeAttachmentViewer() {
    this.avObjectUrls.forEach(u => URL.revokeObjectURL(u));
    this.avObjectUrls = [];
    const content = document.getElementById('avContent');
    if (content) content.innerHTML = '';
  }

  async saveVehicle() {
    const id = document.getElementById('vehicleId').value;
    const initialValueBreakdown = this.collectInitialValueBreakdown();
    const data = {
      name: document.getElementById('vehicleName').value.trim(),
      reg: document.getElementById('vehicleReg').value.trim(),
      year: parseInt(document.getElementById('vehicleYear').value) || null,
      dutyStatus: document.getElementById('vehicleDutyStatus').value || '',
      initialValue: initialValueBreakdown.reduce((s, i) => s + (i.amount || 0), 0),
      initialValueBreakdown: initialValueBreakdown,
      notes: document.getElementById('vehicleNotes').value.trim()
    };
    if (!data.name) { this.toast('Vehicle name is required', 'error'); return; }

    let existingVehicle = null;
    if (id) {
      existingVehicle = this.vehicles.find(v => v.id === parseInt(id));
    }

    if (this.tempVehicleAttachment) {
      data.attachment = await this.blobToBase64(this.tempVehicleAttachment.blob);
      data.attachmentName = this.tempVehicleAttachment.name;
      data.attachmentType = this.tempVehicleAttachment.type;
    } else if (existingVehicle && existingVehicle.attachment) {
      data.attachment = await this.blobToBase64(existingVehicle.attachment);
      data.attachmentName = existingVehicle.attachmentName;
      data.attachmentType = existingVehicle.attachmentType;
    }

    const encrypted = await CryptoEngine.encrypt(data, this.cryptoKey);
    const tx = this.db.transaction('vehicles', 'readwrite');
    const store = tx.objectStore('vehicles');

    if (id) {
      await new Promise((r, j) => {
        const q = store.put({ id: parseInt(id), payload: encrypted });
        q.onsuccess = () => r();
        q.onerror = () => j(q.error);
        tx.onerror = () => j(tx.error);
      });
    } else {
      await new Promise((r, j) => {
        const q = store.add({ payload: encrypted });
        q.onsuccess = () => r();
        q.onerror = () => j(q.error);
        tx.onerror = () => j(tx.error);
      });
    }
    this.tempVehicleAttachment = null;
    await this.loadVehicles();
    this.closeModal('vehicleModal');
    this.toast(id ? 'Vehicle updated' : 'Vehicle added');
    if (!id && this.vehicles.length === 1) {
      await this.selectVehicle(this.vehicles[0].id);
    } else {
      this.renderVehicleSelector();
      this.renderVehicleInfo();
      this.renderDashboard();
      this.renderPrintSections();
    }
  }

  deleteVehicle() {
    this.showConfirm('Delete Vehicle', 'Delete this vehicle and ALL its entries? This cannot be undone.', async () => {
      const tx = this.db.transaction(['vehicles', 'entries'], 'readwrite');
      tx.objectStore('vehicles').delete(this.currentVehicleId);
      const eStore = tx.objectStore('entries');
      const idx = eStore.index('vehicleId');
      const all = await new Promise((r, j) => {
        const q = idx.getAll(this.currentVehicleId);
        q.onsuccess = () => r(q.result);
        q.onerror = () => j(q.error);
        tx.onerror = () => j(tx.error);
      });
      all.forEach(e => eStore.delete(e.id));
      
      await new Promise((r, j) => {
        tx.oncomplete = () => r();
        tx.onerror = () => j(tx.error);
      });
      await this.loadVehicles();
      this.currentVehicleId = this.vehicles.length > 0 ? this.vehicles[0].id : null;
      this.toast('Vehicle deleted');
      if (this.currentVehicleId) await this.selectVehicle(this.currentVehicleId);
      else this.renderEmpty();
    });
  }

  showAddEntry(type) {
    this.clearAttachment();
    document.getElementById('entryId').value = '';
    document.getElementById('entryType').value = type;
    document.getElementById('entryCategoryName').value = '';
    
    const customCatContainer = document.getElementById('customCategoryContainer');
    if (type === 'other') {
      customCatContainer.classList.remove('hidden');
    } else {
      customCatContainer.classList.add('hidden');
    }

    document.getElementById('entryDate').value = this.localDateStr();
    document.getElementById('entryKm').value = '';
    document.getElementById('entrySupplier').value = '';
    document.getElementById('entryParticulars').value = '';
    document.getElementById('entryCost').value = '';
    document.getElementById('entryPart').value = '';
    document.getElementById('entryService').value = '';
    document.getElementById('entryDepreciation').value = '';
    
    const titles = { maintenance: 'Add Maintenance Entry', depreciation: 'Add Depreciation Entry', other: 'Add Custom Expense Entry' };
    document.getElementById('entryModalTitle').textContent = titles[type] || 'Add Entry';
    this.openModal('entryModal');
  }

  async editEntry(id) {
    const e = this.entries.find(x => x.id === id);
    if (!e) return;
    this.clearAttachment();
    document.getElementById('entryId').value = e.id;
    document.getElementById('entryType').value = e.type || 'maintenance';
    
    const customCatContainer = document.getElementById('customCategoryContainer');
    if (e.type === 'other') {
      customCatContainer.classList.remove('hidden');
      document.getElementById('entryCategoryName').value = e.categoryName || '';
    } else {
      customCatContainer.classList.add('hidden');
      document.getElementById('entryCategoryName').value = '';
    }

    document.getElementById('entryDate').value = e.date || '';
    document.getElementById('entryKm').value = e.km != null ? e.km : '';
    document.getElementById('entrySupplier').value = e.supplier || '';
    document.getElementById('entryParticulars').value = e.particulars || '';
    document.getElementById('entryCost').value = e.cost != null ? e.cost : '';
    document.getElementById('entryPart').value = e.part != null ? e.part : '';
    document.getElementById('entryService').value = e.service != null ? e.service : '';
    document.getElementById('entryDepreciation').value = e.depreciation != null ? e.depreciation : '';
    
    if (e.attachmentName) {
      document.getElementById('attachmentLabel').textContent = '📎 ' + e.attachmentName;
      document.getElementById('attachmentLabel').classList.add('text-amber-700', 'bg-amber-50', 'border-amber-300');
      document.getElementById('clearAttachmentBtn').classList.remove('hidden');
      document.getElementById('attachmentName').textContent = 'Existing: ' + e.attachmentName + ' (upload new to replace)';
      document.getElementById('attachmentName').classList.remove('hidden');
    }
    document.getElementById('entryModalTitle').textContent = 'Edit Entry';
    this.openModal('entryModal');
  }

  async saveEntry() {
    const id = document.getElementById('entryId').value;
    const type = document.getElementById('entryType').value || 'maintenance';
    const categoryName = document.getElementById('entryCategoryName').value.trim();

    if (type === 'other' && !categoryName) {
      this.toast('Please provide a name for this custom expense (e.g. Summons)', 'error');
      return;
    }

    const data = {
      type: type,
      categoryName: type === 'other' ? categoryName : null,
      date: document.getElementById('entryDate').value,
      km: document.getElementById('entryKm').value !== '' ? parseFloat(document.getElementById('entryKm').value) : null,
      supplier: document.getElementById('entrySupplier').value.trim(),
      particulars: document.getElementById('entryParticulars').value.trim(),
      cost: document.getElementById('entryCost').value !== '' ? parseFloat(document.getElementById('entryCost').value) : null,
      part: document.getElementById('entryPart').value !== '' ? parseFloat(document.getElementById('entryPart').value) : null,
      service: document.getElementById('entryService').value !== '' ? parseFloat(document.getElementById('entryService').value) : null,
      depreciation: document.getElementById('entryDepreciation').value !== '' ? parseFloat(document.getElementById('entryDepreciation').value) : null
    };

    let existingEntry = null;
    if (id) {
      existingEntry = this.entries.find(x => x.id === parseInt(id));
    }

    if (this.tempAttachment) {
      data.attachment = await this.blobToBase64(this.tempAttachment.blob);
      data.attachmentName = this.tempAttachment.name;
      data.attachmentType = this.tempAttachment.type;
    } else if (existingEntry && existingEntry.attachment) {
      data.attachment = await this.blobToBase64(existingEntry.attachment);
      data.attachmentName = existingEntry.attachmentName;
      data.attachmentType = existingEntry.attachmentType;
    }

    const encrypted = await CryptoEngine.encrypt(data, this.cryptoKey);
    const tx = this.db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');

    if (id) {
      await new Promise((r, j) => {
        const q = store.put({ id: parseInt(id), vehicleId: this.currentVehicleId, payload: encrypted });
        q.onsuccess = () => r();
        q.onerror = () => j(q.error);
        tx.onerror = () => j(tx.error);
      });
    } else {
      await new Promise((r, j) => {
        const q = store.add({ vehicleId: this.currentVehicleId, payload: encrypted });
        q.onsuccess = () => r();
        q.onerror = () => j(q.error);
        tx.onerror = () => j(tx.error);
      });
    }
    this.tempAttachment = null;
    await this.loadEntries(this.currentVehicleId);
    this.closeModal('entryModal');
    this.renderDashboard();
    this.renderEntries();
    this.renderPrintSections();
    this.toast(id ? 'Entry updated' : 'Entry added');
  }

  confirmDeleteEntry(id) {
    this.showConfirm('Delete Entry', 'Are you sure you want to delete this entry?', async () => {
      const tx = this.db.transaction('entries', 'readwrite');
      tx.objectStore('entries').delete(id);
      await new Promise((r, j) => {
        tx.oncomplete = () => r();
        tx.onerror = () => j(tx.error);
      });
      await this.loadEntries(this.currentVehicleId);
      this.renderDashboard();
      this.renderEntries();
      this.renderPrintSections();
      this.toast('Entry deleted');
    });
  }

  onFileSelected(input) {
    if (input.files.length > 0) {
      const file = input.files[0];
      if (!this.checkFileSize(file)) { input.value = ''; return; }
      this.tempAttachment = { blob: file, name: file.name, type: file.type };
      document.getElementById('attachmentLabel').textContent = '📎 ' + file.name;
      document.getElementById('attachmentLabel').classList.add('text-amber-700', 'bg-amber-50', 'border-amber-300');
      document.getElementById('clearAttachmentBtn').classList.remove('hidden');
      document.getElementById('attachmentName').textContent = 'Ready to upload: ' + file.name;
      document.getElementById('attachmentName').classList.remove('hidden');
    }
  }

  clearAttachment() {
    this.tempAttachment = null;
    document.getElementById('entryAttachment').value = '';
    document.getElementById('attachmentLabel').textContent = '📎 Click to upload file';
    document.getElementById('attachmentLabel').classList.remove('text-amber-700', 'bg-amber-50', 'border-amber-300');
    document.getElementById('clearAttachmentBtn').classList.add('hidden');
    document.getElementById('attachmentName').classList.add('hidden');
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  base64ToBlob(dataUrl, type) {
    const byteString = atob(dataUrl.split(',')[1]);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    return new Blob([ab], { type });
  }

  cur() {
    return this.currencySymbol + ' ';
  }

  async loadCurrency() {
    try {
      const tx = this.db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('currency');
      const res = await new Promise((r, j) => { req.onsuccess = () => r(req.result); req.onerror = j; });
      if (res && res.symbol) {
        this.currencySymbol = res.symbol;
        const sel = document.getElementById('currencySelector');
        if (sel) sel.value = res.symbol;
      }
    } catch (e) { console.warn('Currency load failed', e); }
  }

  async setCurrency(symbol) {
    this.currencySymbol = symbol;
    const tx = this.db.transaction('config', 'readwrite');
    tx.objectStore('config').put({ key: 'currency', symbol });
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
    this.renderDashboard();
    this.renderEntries();
    this.renderVehicleInfo();
    this.renderPrintSections();
    this.renderBankLoanLedger();
    this.toast('Currency updated to ' + symbol);
  }

  checkFileSize(file) {
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      this.toast('File exceeds 5MB limit (' + this.fmt(file.size / (1024*1024), 1) + ' MB)', 'error');
      return false;
    }
    return true;
  }

  showExportModal() {
    document.getElementById('exportEncryptToggle').checked = true;
    document.getElementById('unencryptedNotice').classList.add('hidden');
    this.openModal('exportModal');
  }

  toggleExportNotice(checkbox) {
    const notice = document.getElementById('unencryptedNotice');
    if (checkbox.checked) {
      notice.classList.add('hidden');
    } else {
      notice.classList.remove('hidden');
    }
  }

  async confirmExportData() {
    const isEncrypted = document.getElementById('exportEncryptToggle').checked;
    this.closeModal('exportModal');
    
    try {
      const tx = this.db.transaction(['vehicles', 'entries'], 'readonly');
      const vehiclesRaw = await new Promise((r, j) => {
        const q = tx.objectStore('vehicles').getAll();
        q.onsuccess = () => r(q.result);
        q.onerror = () => j(q.error);
      });
      const entriesRaw = await new Promise((r, j) => {
        const q = tx.objectStore('entries').getAll();
        q.onsuccess = () => r(q.result);
        q.onerror = () => j(q.error);
      });

      let exportPayload;
      if (isEncrypted) {
        exportPayload = {
          vehicles: vehiclesRaw,
          entries: entriesRaw,
          exportedAt: new Date().toISOString(),
          isEncrypted: true,
          salt: Array.from(this.salt),
          version: '4.0'
        };
      } else {
        const vehicles = [];
        for (const v of this.vehicles) {
          const copy = { ...v };
          if (v.attachment && v.attachment instanceof Blob) {
            copy.attachment = await this.blobToBase64(v.attachment);
          }
          vehicles.push(copy);
        }
        const entries = [];
        for (const e of this.entries) {
          const copy = { ...e };
          if (e.attachment && e.attachment instanceof Blob) {
            copy.attachment = await this.blobToBase64(e.attachment);
          }
          entries.push(copy);
        }
        exportPayload = { vehicles, entries, exportedAt: new Date().toISOString(), isEncrypted: false, version: '4.0' };
      }

      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fleetlog_backup_${isEncrypted ? 'encrypted_' : 'plain_'}${this.localDateStr()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.toast('Backup downloaded successfully');
    } catch (err) {
      this.toast('Export failed: ' + err.message, 'error');
    }
  }

  async importData(input) {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.vehicles || !data.entries) throw new Error('Invalid file format');

      if (!confirm(`Import ${data.vehicles.length} vehicles and ${data.entries.length} entries? This will REPLACE all existing data!`)) { input.value = ''; return; }

      // Decrypt/prepare everything under the CURRENT session's key BEFORE touching the
      // database, so a wrong passcode or bad file never wipes out existing data.
      const newVehicles = [];
      const newEntries = [];

      if (data.isEncrypted) {
        if (!data.salt) throw new Error('Backup is missing salt data and cannot be decrypted');

        // Try the currently-unlocked session key first (covers re-importing a backup
        // into the same install it came from). Only prompt if that doesn't work.
        let backupKey = this.cryptoKey;
        const sample = data.vehicles[0] || data.entries[0];
        let keyOk = !sample;
        if (sample) {
          try { await CryptoEngine.decrypt(sample.payload, backupKey); keyOk = true; } catch (e) { keyOk = false; }
        }

        if (!keyOk) {
          const backupPasscode = prompt('This backup was encrypted with a different passcode or on a different device.\nEnter the passcode that was used to create it:');
          if (!backupPasscode) { this.toast('Import cancelled', 'error'); input.value = ''; return; }
          backupKey = await CryptoEngine.deriveKey(backupPasscode, new Uint8Array(data.salt));
          if (sample) {
            try { await CryptoEngine.decrypt(sample.payload, backupKey); } catch (e) { throw new Error('Incorrect passcode for this backup'); }
          }
        }

        for (const v of data.vehicles) {
          const decrypted = await CryptoEngine.decrypt(v.payload, backupKey);
          newVehicles.push({ id: v.id, payload: await CryptoEngine.encrypt(decrypted, this.cryptoKey) });
        }
        for (const e of data.entries) {
          const decrypted = await CryptoEngine.decrypt(e.payload, backupKey);
          newEntries.push({ id: e.id, vehicleId: e.vehicleId, payload: await CryptoEngine.encrypt(decrypted, this.cryptoKey) });
        }
      } else {
        for (const v of data.vehicles) {
          const { id, ...rest } = v;
          newVehicles.push({ id, payload: await CryptoEngine.encrypt(rest, this.cryptoKey) });
        }
        for (const e of data.entries) {
          const { id, vehicleId, ...rest } = e;
          newEntries.push({ id, vehicleId: vehicleId || this.currentVehicleId, payload: await CryptoEngine.encrypt(rest, this.cryptoKey) });
        }
      }

      const tx1 = this.db.transaction(['vehicles', 'entries'], 'readwrite');
      tx1.objectStore('vehicles').clear();
      tx1.objectStore('entries').clear();
      await new Promise((r, j) => { tx1.oncomplete = r; tx1.onerror = () => j(tx1.error); });

      const tx2 = this.db.transaction(['vehicles', 'entries'], 'readwrite');
      const vStore = tx2.objectStore('vehicles');
      const eStore = tx2.objectStore('entries');
      for (const v of newVehicles) {
        if (v.id != null) vStore.add({ id: v.id, payload: v.payload }); else vStore.add({ payload: v.payload });
      }
      for (const e of newEntries) {
        if (e.id != null) eStore.add({ id: e.id, vehicleId: e.vehicleId, payload: e.payload }); else eStore.add({ vehicleId: e.vehicleId, payload: e.payload });
      }
      await new Promise((r, j) => { tx2.oncomplete = r; tx2.onerror = () => j(tx2.error); });

      await this.loadVehicles();
      if (this.vehicles.length > 0) await this.selectVehicle(this.vehicles[0].id);
      else this.renderEmpty();
      this.toast('Import successful');
    } catch (err) {
      this.toast('Import failed: ' + err.message, 'error');
    }
    input.value = '';
  }

  showConfirm(title, message, onConfirm) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    this.pendingDelete = onConfirm;
    const btn = document.getElementById('confirmBtn');
    btn.onclick = () => {
      this.closeModal('confirmModal');
      if (this.pendingDelete) this.pendingDelete();
      this.pendingDelete = null;
    };
    this.openModal('confirmModal');
  }

  setPrintOrientation(value) {
    let styleEl = document.getElementById('dynamicPrintOrientation');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dynamicPrintOrientation';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `@media print { @page { size: A4 ${value}; margin: 10mm; } }`;
  }

  openModal(id) {
    const el = document.getElementById(id);
    el.classList.remove('hidden');
    el.classList.add('flex');
  }

  closeModal(id) {
    const el = document.getElementById(id);
    el.classList.add('hidden');
    el.classList.remove('flex');
    if (id === 'vehicleModal') this.tempVehicleAttachment = null;
    if (id === 'entryModal') this.tempAttachment = null;
    if (id === 'attachmentViewerModal') this.closeAttachmentViewer();
  }

  fmt(n, d = 2) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  localDateStr(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  formatDisplayDate(dateStr) {
    if (!dateStr) return '-';
    const parts = dateStr.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return dateStr;
  }

  escape(str) {
    if (str === null || str === undefined || str === '') return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  toast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg transform transition-all duration-300 z-50 no-print ${type === 'error' ? 'bg-red-600 text-white' : 'bg-slate-800 text-white'}`;
    t.style.transform = 'translateY(0)';
    t.style.opacity = '1';
    setTimeout(() => { t.style.transform = 'translateY(20px)'; t.style.opacity = '0'; }, 3000);
  }
}

let app;

document.addEventListener('DOMContentLoaded', () => {
  app = new FleetApp();
  app.init();

  document.getElementById('exportModal').addEventListener('click', e => { if (e.target === e.currentTarget) app.closeModal('exportModal'); });
  document.getElementById('vehicleModal').addEventListener('click', e => { if (e.target === e.currentTarget) app.closeModal('vehicleModal'); });
  document.getElementById('entryModal').addEventListener('click', e => { if (e.target === e.currentTarget) app.closeModal('entryModal'); });
  document.getElementById('bankLoanModal').addEventListener('click', e => { if (e.target === e.currentTarget) app.closeModal('bankLoanModal'); });
  document.getElementById('confirmModal').addEventListener('click', e => { if (e.target === e.currentTarget) app.closeModal('confirmModal'); });
  document.getElementById('attachmentViewerModal').addEventListener('click', e => { if (e.target === e.currentTarget) app.closeModal('attachmentViewerModal'); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      app.closeModal('exportModal');
      app.closeModal('vehicleModal');
      app.closeModal('entryModal');
      app.closeModal('bankLoanModal');
      app.closeModal('confirmModal');
      app.closeModal('attachmentViewerModal');
    }
  });
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache:'none' stops the browser from serving sw.js itself out of the
    // HTTP cache, which is the most common reason a bumped CACHE_NAME silently fails
    // to be noticed — the browser never even fetches the new sw.js bytes to compare.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => {
        console.log('FleetLog SW registered:', reg.scope);

        // Actively ask the browser to check for a newer sw.js on every load,
        // instead of waiting for its infrequent background check.
        reg.update().catch(() => {});

        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => console.error('FleetLog SW registration failed:', err));

    // Once the new service worker takes control, the page is still running on
    // old cached assets until it reloads once — so do that automatically.
    let refreshingForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshingForUpdate) return;
      refreshingForUpdate = true;
      window.location.reload();
    });
  });
}

/* ============================================================
 * Delegated event dispatcher
 * Replaces inline on* HTML attributes so the CSP script-src can
 * drop 'unsafe-inline'. Elements declare intent via data-click /
 * data-change / data-input / data-submit / data-mouseenter /
 * data-mouseleave attributes (holding an app.* method name) plus
 * an optional data-*-args JSON array of arguments. Sentinel
 * strings "@event", "@this", "@value" are resolved at dispatch
 * time to the real event/element/value — never eval()'d.
 * ============================================================ */
(function () {
  function resolveArgs(json, evt, el) {
    if (!json) return [];
    let raw;
    try { raw = JSON.parse(json); } catch (err) { return []; }
    return raw.map(a => {
      if (a === '@event') return evt;
      if (a === '@this') return el;
      if (a === '@value') return el.value;
      return a;
    });
  }

  function bind(eventType, attr, useCapture) {
    document.addEventListener(eventType, function (evt) {
      const el = evt.target.closest ? evt.target.closest('[data-' + attr + ']') : null;
      if (!el) return;
      const action = el.getAttribute('data-' + attr);
      if (!action) return;
      if (action === 'print') { window.print(); return; }
      if (!app || typeof app[action] !== 'function') return;
      const args = resolveArgs(el.getAttribute('data-' + attr + '-args'), evt, el);
      app[action](...args);
    }, useCapture);
  }

  bind('click', 'click', false);
  bind('change', 'change', false);
  bind('input', 'input', false);
  bind('submit', 'submit', false);
  // mouseenter/mouseleave don't bubble, but they DO pass through the
  // capture phase, so delegate by listening during capture.
  bind('mouseenter', 'mouseenter', true);
  bind('mouseleave', 'mouseleave', true);
})();
