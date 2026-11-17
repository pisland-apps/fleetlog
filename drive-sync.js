/* ============================================================================
 * FleetLog — Google Drive sync (v1.10.0)
 *
 * How it works (same idea as the companion Ledger app, simplified for FleetLog):
 *  - ONE encrypted backup file (fleetlog-backup.json) lives in this Google
 *    account's hidden app-data folder in Drive (OAuth scope drive.appdata: the
 *    app can only ever see its own hidden files, never anything else in Drive).
 *  - The file is exactly the encrypted "Export JSON" format (the records are
 *    uploaded as they already sit in IndexedDB, still encrypted), plus a small
 *    `drive` block. Google never sees anything readable.
 *  - ONE device is the PRIMARY (fleetlog-primary.json in Drive says which).
 *      primary device  -> auto-uploads a few seconds after every change
 *      other device(s) -> never auto-upload; use "Download from Drive" /
 *                         "Upload to Drive" by hand when something changed
 *  - Safety rules:
 *      * auto-upload never overwrites a Drive copy that someone else changed
 *        since this device last synced -> it pauses and asks (conflict banner);
 *      * a download that would replace unsynced local changes first stores a
 *        local safety copy (Settings in the cloud dialog -> "Local safety copies").
 *
 * Everything Drive-related stays out of the backup/export files; the device's
 * own sync state lives in localStorage under "fleetlogDrive." (a different
 * key set from the Ledger app, even on the same web address).
 *
 * Loaded after app.js (see index.html). Adds methods to FleetApp.prototype;
 * the few hooks app.js calls are all guarded with typeof checks, so the app
 * still works if this file ever fails to load.
 * ========================================================================== */
(function () {
  'use strict';

  // Public OAuth client id (not a secret). Same Google Cloud project as the
  // Ledger app: the address FleetLog is served from must be listed under
  // "Authorized JavaScript origins" for this client in Google Cloud Console.
  const GOOGLE_CLIENT_ID = '285114774867-rlmhqub7hsmnmuqtjcvedaegm00u73kl.apps.googleusercontent.com';
  const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const BACKUP_NAME = 'fleetlog-backup.json';
  const PRIMARY_NAME = 'fleetlog-primary.json';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
  const LS = 'fleetlogDrive.';
  const SNAPSHOT_KEEP = 3;

  FleetApp.DRIVE_DEBOUNCE_MS = 4000;      // wait after the last edit before auto-uploading
  FleetApp.DRIVE_CHECK_MIN_GAP_MS = 30000; // min gap between background "has Drive changed?" checks

  // ---- tiny localStorage helpers (device-local sync state) -------------------
  const ls = {
    get(k) { try { return localStorage.getItem(LS + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(LS + k, String(v)); } catch (e) { /* non-fatal */ } },
    del(k) { try { localStorage.removeItem(LS + k); } catch (e) { /* non-fatal */ } }
  };

  // Chunked bytes -> base64 (the per-byte loop in bufToBase64 is slow for
  // multi-MB records).
  function bytesToB64(arr) {
    const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function fmtWhen(ms) {
    if (!ms) return 'unknown time';
    try { return new Date(Number(ms)).toLocaleString(); } catch (e) { return 'unknown time'; }
  }

  const P = FleetApp.prototype;

  // ============================================================================
  // State
  // ============================================================================
  P._drv = function () {
    if (!this._drive) {
      this._drive = {
        token: null, tokenExp: 0, tokenClient: null, tokenPromise: null,
        onToken: null, onTokenError: null,
        inFlight: false, timer: null, pending: false, seq: 0, resync: false,
        retryTimer: null, retryCount: 0, errorNote: '',
        remote: null,                       // last seen backup file: { fileId, rev, deviceId, deviceName, syncedAt }
        primary: { status: 'unknown', deviceName: '' }, // 'none' | 'me' | 'other'
        lastCheckAt: 0, needsReauth: false, listenersInstalled: false, busy: ''
      };
    }
    return this._drive;
  };

  P._driveConnected = function () { return ls.get('connected') === '1'; };
  P._driveAutoOn = function () { return ls.get('autoSync') !== '0'; };

  P._driveDeviceId = function () {
    let id = ls.get('deviceId');
    if (!id) {
      id = 'fl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      ls.set('deviceId', id);
    }
    return id;
  };

  P._driveDeviceName = function () {
    let name = ls.get('deviceName');
    if (!name) {
      name = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '') ? 'Phone' : 'Computer';
      ls.set('deviceName', name);
    }
    return name;
  };

  // ============================================================================
  // Dirty tracking: every real local write to vehicles/entries counts as an
  // unsynced change. Done once, at the IndexedDB layer, so no save/delete/import
  // path can be forgotten (and a future one is picked up automatically).
  // Writes made by Drive sync itself are excluded via _driveSuppressDirty.
  // ============================================================================
  P._driveInstallDbHook = function () {
    const db = this.db;
    if (!db || db._fleetDriveHooked) return;
    const orig = db.transaction.bind(db);
    const self = this;
    db.transaction = function (stores, mode, ...rest) {
      const tx = orig(stores, mode, ...rest);
      try {
        if (mode === 'readwrite') {
          const names = typeof stores === 'string' ? [stores] : Array.from(stores);
          if ((names.includes('vehicles') || names.includes('entries')) && !self._driveSuppressDirty) {
            tx.addEventListener('complete', () => self.driveMarkDirty());
          }
        }
      } catch (e) { /* never let tracking break a write */ }
      return tx;
    };
    db._fleetDriveHooked = true;
  };

  P.driveMarkDirty = function () {
    const d = this._drv();
    d.seq++;
    ls.set('dirty', '1');
    this._driveRender();
    this._driveScheduleAutoUpload();
  };

  P._driveScheduleAutoUpload = function () {
    if (!this._driveConnected() || !this._driveAutoOn()) return;
    if (ls.get('primaryMe') !== '1') return;   // only the primary auto-uploads (re-verified against Drive before any upload)
    if (ls.get('pause')) return;               // unresolved conflict
    this._driveArmTimer();
  };

  P._driveArmTimer = function () {
    const d = this._drv();
    clearTimeout(d.timer);
    d.pending = true;
    this._driveRender();
    d.timer = setTimeout(() => {
      d.pending = false;
      this._driveAutoUploadAttempt().catch(err => console.warn('Drive auto-upload failed:', err));
    }, FleetApp.DRIVE_DEBOUNCE_MS);
  };

  // Leaving/backgrounding the app: don't sit out the rest of the debounce.
  P._driveFlushPending = function () {
    const d = this._drv();
    if (!d.pending) return Promise.resolve();
    d.pending = false;
    clearTimeout(d.timer);
    return this._driveAutoUploadAttempt().catch(err => console.warn('Drive flush failed:', err));
  };

  // ============================================================================
  // Google sign-in (Google Identity Services, loaded only when needed)
  // ============================================================================
  P._driveLoadGis = function () {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (this._gisPromise) return this._gisPromise;
    this._gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = () => {
        if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) resolve();
        else reject(new Error('Google sign-in script did not initialise'));
      };
      s.onerror = () => reject(new Error('Could not load Google sign-in (offline?)'));
      document.head.appendChild(s);
    }).catch(err => { this._gisPromise = null; throw err; });
    return this._gisPromise;
  };

  P._driveEnsureClient = async function () {
    const d = this._drv();
    if (d.tokenClient) return;
    await this._driveLoadGis();
    d.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (resp) => { if (d.onToken) d.onToken(resp); },
      // popup blocked / closed / failed to open never reach `callback`
      error_callback: (err) => { if (d.onTokenError) d.onTokenError(err); }
    });
  };

  // interactive = true -> consent popup (Connect button); false -> silent refresh.
  // The pending promise is stored synchronously so two callers can never start
  // two token requests at once.
  P._driveToken = function (interactive) {
    const d = this._drv();
    if (d.token && Date.now() < d.tokenExp - 60000) return Promise.resolve(d.token);
    if (d.tokenPromise) return d.tokenPromise;
    d.tokenPromise = (async () => {
      await this._driveEnsureClient();
      const prompt = interactive ? 'consent' : '';
      const hint = ls.get('email') || '';
      return new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn, v) => { clearTimeout(timer); d.onToken = null; d.onTokenError = null; fn(v); };
        timer = setTimeout(() => done(reject, new Error('Google sign-in timed out')), interactive ? 180000 : 20000);
        d.onToken = (resp) => {
          if (!resp || resp.error) { done(reject, new Error('Google sign-in was not completed')); return; }
          d.token = resp.access_token;
          d.tokenExp = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3300 * 1000);
          d.needsReauth = false;
          done(resolve, d.token);
        };
        d.onTokenError = (err) => done(reject, new Error('Google sign-in failed' + (err && err.type ? ' (' + err.type + ')' : '')));
        try {
          const cfg = { prompt };
          if (hint) cfg.hint = hint;
          d.tokenClient.requestAccessToken(cfg);
        } catch (e) { done(reject, e); }
      });
    })().then(
      (t) => { d.tokenPromise = null; return t; },
      (e) => { d.tokenPromise = null; d.needsReauth = true; this._driveRender(); throw e; }
    );
    return d.tokenPromise;
  };

  // Drive API call with timeout + one retry on 401 (expired/revoked token).
  P._driveApi = async function (url, opts, ms) {
    const d = this._drv();
    const run = async () => {
      const token = await this._driveToken(false);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms || 45000);
      try {
        const o = Object.assign({}, opts || {});
        o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + token });
        o.signal = ctl.signal;
        return await fetch(url, o);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('Google Drive request timed out');
        throw e;
      } finally { clearTimeout(t); }
    };
    let resp = await run();
    if (resp.status === 401) { d.token = null; d.tokenExp = 0; resp = await run(); }
    return resp;
  };

  // ============================================================================
  // Drive file helpers
  // ============================================================================
  async function readJsonOrThrow(resp, what) {
    if (!resp.ok) throw new Error(what + ' failed (' + resp.status + ')');
    return resp.json();
  }

  // Newest backup file (or null). Always looked up fresh — never trust a cached
  // id, Drive allows several files with the same name.
  P._driveFindBackup = async function () {
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name='" + BACKUP_NAME + "' and trashed=false",
      fields: 'files(id,modifiedTime,appProperties)',
      orderBy: 'modifiedTime desc',
      pageSize: '10'
    });
    const data = await readJsonOrThrow(await this._driveApi(API + '?' + q), 'Drive lookup');
    const files = data.files || [];
    if (!files.length) { this._drv().remote = null; return null; }
    const f = files[0];
    const ap = f.appProperties || {};
    const remote = {
      fileId: f.id, rev: f.modifiedTime || null,
      deviceId: ap.deviceId || '', deviceName: ap.deviceName || '', syncedAt: ap.syncedAt ? Number(ap.syncedAt) : null,
      extraIds: files.slice(1).map(x => x.id)
    };
    this._drv().remote = remote;
    return remote;
  };

  // Small JSON file (the primary-device record) — plain multipart upload.
  P._driveWriteSmall = async function (name, obj, fileId) {
    const metadata = fileId ? { name } : { name, parents: ['appDataFolder'] };
    const boundary = 'fleetlogdrive' + Date.now().toString(36);
    const body =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(obj) + '\r\n--' + boundary + '--';
    const url = (fileId ? UPLOAD_API + '/' + fileId : UPLOAD_API) + '?uploadType=multipart&fields=id,modifiedTime';
    const resp = await this._driveApi(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    });
    return readJsonOrThrow(resp, 'Drive write');
  };

  // The backup can be many MB (attachments are inside it), beyond what a plain
  // multipart upload is meant for -> resumable upload; falls back to multipart
  // if the browser can't read the session address.
  P._driveUploadBackup = async function (fileId, appProperties, bodyBlob) {
    const meta = { name: BACKUP_NAME, appProperties };
    if (!fileId) meta.parents = ['appDataFolder'];
    const initUrl = (fileId ? UPLOAD_API + '/' + fileId : UPLOAD_API) + '?uploadType=resumable&fields=id,modifiedTime';
    let location = null;
    try {
      const init = await this._driveApi(initUrl, {
        method: fileId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      });
      if (init.ok) location = init.headers.get('Location');
      else if (init.status === 401 || init.status === 403 || init.status === 404) throw new Error('Drive upload failed (' + init.status + ')');
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // network/CORS problem on the init step -> try multipart below
    }
    if (location) {
      const put = await this._driveApi(location, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bodyBlob }, 300000);
      return readJsonOrThrow(put, 'Drive upload');
    }
    // multipart fallback
    const boundary = 'fleetlogbackup' + Date.now().toString(36);
    const body = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n' +
      '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n',
      bodyBlob,
      '\r\n--' + boundary + '--'
    ]);
    const url = (fileId ? UPLOAD_API + '/' + fileId : UPLOAD_API) + '?uploadType=multipart&fields=id,modifiedTime';
    const resp = await this._driveApi(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    }, 300000);
    return readJsonOrThrow(resp, 'Drive upload');
  };

  // ---- primary-device record ---------------------------------------------------
  P._driveFetchPrimary = async function () {
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name='" + PRIMARY_NAME + "' and trashed=false",
      fields: 'files(id,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '10'
    });
    const files = (await readJsonOrThrow(await this._driveApi(API + '?' + q), 'Drive primary lookup')).files || [];
    if (!files.length) return { fileId: null, rec: null };
    const chosen = files[0];
    for (const f of files.slice(1)) { // two devices claiming at once: keep the newest, drop the rest
      try { await this._driveApi(API + '/' + f.id, { method: 'DELETE' }); } catch (e) { /* best effort */ }
    }
    const r = await this._driveApi(API + '/' + chosen.id + '?alt=media');
    if (!r.ok) throw new Error('Drive primary read failed (' + r.status + ')');
    let rec = null;
    try { rec = await r.json(); } catch (e) { rec = null; }
    return { fileId: chosen.id, rec };
  };

  P._driveSetPrimaryState = function (rec) {
    const d = this._drv();
    const me = this._driveDeviceId();
    if (!rec || !rec.deviceId) d.primary = { status: 'none', deviceName: '' };
    else if (rec.deviceId === me) d.primary = { status: 'me', deviceName: rec.deviceName || this._driveDeviceName() };
    else d.primary = { status: 'other', deviceName: rec.deviceName || 'Another device' };
    if (d.primary.status === 'me') ls.set('primaryMe', '1');
    else { ls.del('primaryMe'); ls.del('pause'); } // an auto-upload conflict only concerns the primary
    this._driveRender();
    return d.primary.status;
  };

  // ============================================================================
  // Build / upload
  // ============================================================================
  async function getAll(tx, name) {
    return new Promise((r, j) => {
      const q = tx.objectStore(name).getAll();
      q.onsuccess = () => r(q.result);
      q.onerror = () => j(q.error);
    });
  }

  // The Drive payload = the encrypted Export JSON format + a `drive` block.
  // Records are read raw from IndexedDB (still encrypted), so no passcode is
  // needed to upload.
  P._driveBuildPayload = async function () {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this._rekeying) { await new Promise(r => setTimeout(r, 500)); continue; } // passcode change / PBKDF2 upgrade in progress
      if (!this.salt) throw new Error('App data is not ready yet');
      const saltBefore = Array.from(this.salt).join(',');
      const itersBefore = this.iterations;
      const tx = this.db.transaction(['vehicles', 'entries'], 'readonly');
      const vehiclesRaw = await getAll(tx, 'vehicles');
      const entriesRaw = await getAll(tx, 'entries');
      // records and salt must belong together: if the key was swapped while
      // reading, read again
      if (this._rekeying || Array.from(this.salt).join(',') !== saltBefore || this.iterations !== itersBefore) continue;
      const enc = (row, what) => {
        if (!row.payload) throw new Error('A ' + what + ' record is not encrypted — use Export JSON for a manual backup instead.');
        return { iv: bytesToB64(row.payload.iv), cipherText: bytesToB64(row.payload.cipherText) };
      };
      return {
        vehicles: vehiclesRaw.map(v => ({ id: v.id, payload: enc(v, 'vehicle') })),
        entries: entriesRaw.map(e => ({ id: e.id, vehicleId: e.vehicleId, payload: enc(e, 'entry') })),
        exportedAt: new Date().toISOString(),
        isEncrypted: true,
        salt: Array.from(this.salt),
        iterations: this.iterations,
        version: '4.0',
        drive: { v: 1, deviceId: this._driveDeviceId(), deviceName: this._driveDeviceName(), syncedAt: Date.now(), currency: this.currencySymbol }
      };
    }
    throw new Error('Data was being re-encrypted — try again in a moment.');
  };

  // Uploads this device's data to the backup file. `remote` = result of
  // _driveFindBackup() (or null when no file exists yet).
  P._driveUpload = async function (remote) {
    const d = this._drv();
    const seq = d.seq;
    const payload = await this._driveBuildPayload();
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const props = {
      deviceId: this._driveDeviceId(),
      deviceName: String(this._driveDeviceName()).slice(0, 60),
      syncedAt: String(payload.drive.syncedAt)
    };
    const res = await this._driveUploadBackup(remote ? remote.fileId : null, props, blob);
    ls.set('lastRev', res.modifiedTime || '');
    ls.set('lastSyncedAt', Date.now());
    ls.del('pause');
    d.remote = { fileId: res.id, rev: res.modifiedTime, deviceId: props.deviceId, deviceName: props.deviceName, syncedAt: payload.drive.syncedAt };
    // anything edited while this upload was running is still unsynced
    if (d.seq === seq) ls.del('dirty'); else d.resync = true;
    d.errorNote = '';
    d.retryCount = 0;
    clearTimeout(d.retryTimer);
    // older same-named duplicates (two devices creating the first file at once)
    if (remote && remote.extraIds && remote.extraIds.length) {
      for (const id of remote.extraIds) {
        try { await this._driveApi(API + '/' + id, { method: 'DELETE' }); } catch (e) { /* best effort */ }
      }
    }
    return res;
  };

  // Runs fn as "the" sync operation: one at a time, errors captured for the UI.
  P._driveRun = async function (fn, { rethrow = false, busyLabel = '' } = {}) {
    const d = this._drv();
    if (d.inFlight) { if (!rethrow) d.resync = true; return false; }
    d.inFlight = true;
    d.busy = busyLabel;
    this._driveRender();
    try {
      await fn();
      return true;
    } catch (err) {
      d.errorNote = (err && err.message) ? err.message : String(err);
      if (rethrow) throw err;
      console.warn('Drive sync error:', err);
      this._driveScheduleRetry();
      return false;
    } finally {
      d.inFlight = false;
      d.busy = '';
      if (d.resync) { d.resync = false; this._driveScheduleAutoUpload(); }
      this._driveRender();
    }
  };

  P._driveScheduleRetry = function () {
    const d = this._drv();
    if (d.retryCount >= 3 || ls.get('primaryMe') !== '1' || !this._driveAutoOn()) return;
    d.retryCount++;
    clearTimeout(d.retryTimer);
    d.retryTimer = setTimeout(() => this._driveScheduleAutoUpload(), 30000 * d.retryCount);
  };

  // ============================================================================
  // Auto-upload (primary device only)
  // ============================================================================
  P._driveAutoUploadAttempt = async function () {
    if (!this._driveConnected() || !this._driveAutoOn()) return;
    if (ls.get('pause')) return;
    if (ls.get('dirty') !== '1') return;
    const d = this._drv();
    if (d.inFlight) { d.resync = true; return; }
    await this._driveRun(async () => {
      await this._driveToken(false);
      // 1. still the primary? (someone may have moved it to another device)
      const { rec } = await this._driveFetchPrimary();
      if (this._driveSetPrimaryState(rec) !== 'me') return;
      // 2. has Drive changed since this device last synced?
      const remote = await this._driveFindBackup();
      if (remote && this._driveRemoteAhead(remote)) {
        ls.set('pause', JSON.stringify({ at: Date.now(), rev: remote.rev, by: remote.deviceName || '' }));
        return; // conflict: both sides changed — the banner asks what to do
      }
      // 3. safe to upload
      await this._driveUpload(remote);
    }, { busyLabel: 'Uploading…' });
  };

  // Is the Drive copy newer than what this device last synced?
  // (A file this same device uploaded itself — e.g. the app was killed before the
  // revision could be saved — counts as already known.)
  P._driveRemoteAhead = function (remote) {
    if (!remote) return false;
    if (remote.rev && remote.rev === ls.get('lastRev')) return false;
    if (remote.deviceId && remote.deviceId === this._driveDeviceId()) {
      ls.set('lastRev', remote.rev || '');
      return false;
    }
    return true;
  };

  // ============================================================================
  // Checking Drive (on unlock, when the app comes back to the front, on demand)
  // ============================================================================
  P._driveRefresh = async function () {
    const d = this._drv();
    await this._driveToken(false);
    const [remote, prim] = await Promise.all([this._driveFindBackup(), this._driveFetchPrimary()]);
    this._driveSetPrimaryState(prim.rec);
    d.lastCheckAt = Date.now();
    d.errorNote = '';
    return remote;
  };

  P._driveCheckQuiet = async function (announce) {
    if (!this._driveConnected()) return;
    const d = this._drv();
    if (d.inFlight) return;
    try {
      const remote = await this._driveRefresh();
      const ahead = this._driveRemoteAhead(remote);
      this._driveRender();
      if (ahead && announce) this.toast('☁️ Newer data on Google Drive — open ☁️ to download it');
      // edits made before the app was closed that never reached Drive
      if (ls.get('dirty') === '1') this._driveScheduleAutoUpload();
    } catch (err) {
      d.errorNote = err && err.message ? err.message : String(err);
      this._driveRender();
    }
  };

  P.driveOnUnlock = function () {
    const d = this._drv();
    if (!d.listenersInstalled) {
      d.listenersInstalled = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { this._driveFlushPending(); return; }
        if (this.cryptoKey && Date.now() - d.lastCheckAt > FleetApp.DRIVE_CHECK_MIN_GAP_MS) this._driveCheckQuiet(true);
      });
      window.addEventListener('pagehide', () => this._driveFlushPending());
      window.addEventListener('online', () => { if (ls.get('dirty') === '1') this._driveScheduleAutoUpload(); });
    }
    this._driveRender();
    if (this._driveConnected()) this._driveCheckQuiet(true);
  };

  P.driveCheckNow = async function (btnEl) {
    if (!this._driveConnected()) return;
    this._driveBtnBusy(btnEl, true);
    try {
      const remote = await this._driveRefresh();
      const ahead = this._driveRemoteAhead(remote);
      this._driveRender();
      this.toast(ahead ? '☁️ Newer data found on Google Drive' : '☁️ Up to date with Google Drive');
    } catch (err) {
      this._drv().errorNote = err && err.message ? err.message : String(err);
      this._driveRender();
      this.toast('Could not reach Google Drive: ' + this._drv().errorNote, 'error');
    } finally { this._driveBtnBusy(btnEl, false); }
  };

  // ============================================================================
  // Connect / disconnect
  // ============================================================================
  P.driveConnect = async function (btnEl) {
    const wasConnected = this._driveConnected();
    this._driveBtnBusy(btnEl, true);
    try {
      await this._driveToken(true);
      let email = '';
      try {
        const about = await readJsonOrThrow(await this._driveApi('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)'), 'Account lookup');
        email = (about && about.user && about.user.emailAddress) || '';
      } catch (e) { /* cosmetic only */ }
      if (email) ls.set('email', email);
      ls.set('connected', '1');
      this._drv().needsReauth = false;
      this._driveRender();

      if (!wasConnected) {
        const remote = await this._driveFindBackup();
        const { rec } = await this._driveFetchPrimary();
        this._driveSetPrimaryState(rec);
        if (!remote) {
          if (confirm('Google Drive has no FleetLog backup yet.\n\nUpload this device\'s data now and make THIS device the primary one (the one that auto-uploads)?\n\nOK = upload and make primary. Cancel = just connect; decide later.')) {
            await this._driveRun(async () => {
              await this._driveUpload(null);
              await this._driveClaimPrimary();
            }, { rethrow: true, busyLabel: 'Uploading…' });
            this.toast('☁️ Uploaded — this device is now the primary');
          }
        } else if (confirm('A FleetLog backup was found in this Google account\'s Drive (from ' + (remote.deviceName || 'another device') + ', ' + fmtWhen(remote.syncedAt) + ').\n\nDownload it now and REPLACE the data on this device?\n\nOK = download. Cancel = connect only; nothing is changed (you can download later from the ☁️ dialog).')) {
          await this.driveDownloadNow(null, { skipConfirm: true });
        }
      } else {
        await this._driveCheckQuiet(false);
      }
      this.toast('☁️ Google Drive connected');
    } catch (err) {
      alert('Google Drive: ' + (err && err.message ? err.message : err));
    } finally {
      this._driveBtnBusy(btnEl, false);
      this._driveRender();
    }
  };

  P.driveDisconnect = function () {
    if (!confirm('Disconnect Google Drive? The backup stays in your Drive; this device just stops syncing until you reconnect.')) return;
    const d = this._drv();
    if (d.token) { try { google.accounts.oauth2.revoke(d.token, () => {}); } catch (e) { /* best effort */ } }
    d.token = null; d.tokenExp = 0; d.remote = null; d.errorNote = '';
    clearTimeout(d.timer); d.pending = false;
    ls.del('connected'); ls.del('pause'); ls.del('primaryMe');
    d.primary = { status: 'unknown', deviceName: '' };
    this._driveRender();
    this.toast('Google Drive disconnected');
  };

  // ============================================================================
  // Primary device
  // ============================================================================
  P._driveClaimPrimary = async function () {
    const { fileId } = await this._driveFetchPrimary();
    const rec = { v: 1, deviceId: this._driveDeviceId(), deviceName: this._driveDeviceName(), claimedAt: Date.now() };
    await this._driveWriteSmall(PRIMARY_NAME, rec, fileId);
    this._driveSetPrimaryState(rec);
  };

  P.driveMakePrimary = async function (btnEl) {
    this._driveBtnBusy(btnEl, true);
    try {
      await this._driveToken(false);
      const { rec } = await this._driveFetchPrimary();
      const remote = await this._driveFindBackup();
      const me = this._driveDeviceId();
      if (rec && rec.deviceId && rec.deviceId !== me) {
        if (!confirm((rec.deviceName || 'The other device') + ' is the primary device now. It will stop auto-uploading and only pull changes.\n\nMake sure it has finished syncing, then continue?')) return;
      }
      if (remote && remote.deviceId !== me && remote.rev !== ls.get('lastRev')) {
        if (!confirm('Google Drive has data this device has not downloaded yet (from ' + (remote.deviceName || 'another device') + ', ' + fmtWhen(remote.syncedAt) + ').\n\nYou can make this device primary anyway — its next auto-upload will pause and ask before overwriting that data.\n\nContinue?')) return;
      }
      await this._driveClaimPrimary();
      this.toast('⭐ This device is now the primary');
      if (ls.get('dirty') === '1') this._driveScheduleAutoUpload();
    } catch (err) {
      alert('Could not change the primary device: ' + (err && err.message ? err.message : err));
    } finally {
      this._driveBtnBusy(btnEl, false);
      this._driveRender();
    }
  };

  P.driveToggleAutoSync = function (checkbox) {
    ls.set('autoSync', checkbox && checkbox.checked ? '1' : '0');
    if (this._driveAutoOn()) this._driveScheduleAutoUpload();
    else { const d = this._drv(); clearTimeout(d.timer); d.pending = false; }
    this._driveRender();
  };

  P.driveSaveDeviceName = async function (input) {
    const name = (input && input.value || '').trim().slice(0, 40);
    if (!name) { if (input) input.value = this._driveDeviceName(); return; }
    ls.set('deviceName', name);
    if (this._drv().primary.status === 'me' && this._driveConnected()) {
      try { await this._driveClaimPrimary(); } catch (e) { /* the name is still saved locally */ }
    }
    this._driveRender();
  };

  // ============================================================================
  // Manual upload / download (any device)
  // ============================================================================
  P.driveUploadNow = async function (btnEl) {
    if (!this._driveConnected()) return;
    this._driveBtnBusy(btnEl, true);
    try {
      await this._driveToken(false);
      const remote = await this._driveFindBackup();
      const { rec } = await this._driveFetchPrimary();
      const status = this._driveSetPrimaryState(rec);
      const me = this._driveDeviceId();
      const moved = !!remote && remote.deviceId !== me && remote.rev !== ls.get('lastRev');
      let msg = '';
      if (moved) msg += 'Google Drive has changes this device has NOT downloaded yet (from ' + (remote.deviceName || 'another device') + ', ' + fmtWhen(remote.syncedAt) + '). Uploading now overwrites them.\n\n';
      if (status === 'other') msg += (this._drv().primary.deviceName || 'Another device') + ' is the primary device.\n\n';
      if (status === 'none') msg += 'Drive has no primary device yet — this device will become the primary.\n\n';
      msg += moved ? 'OK = overwrite Drive with this device\'s data. Cancel = stop (download first).' : 'Upload this device\'s data to Google Drive?';
      if (!confirm(msg)) return;
      const ok = await this._driveRun(async () => {
        await this._driveUpload(remote);
        if (status === 'none') await this._driveClaimPrimary();
      }, { rethrow: true, busyLabel: 'Uploading…' });
      if (ok) this.toast('☁️ Uploaded to Google Drive');
    } catch (err) {
      alert('Upload failed: ' + (err && err.message ? err.message : err));
    } finally {
      this._driveBtnBusy(btnEl, false);
      this._driveRender();
    }
  };

  // "Use Drive's copy" in the conflict banner is the same thing as a download.
  P.driveUseDriveCopy = function (btnEl) { return this.driveDownloadNow(btnEl); };

  // "Keep this device" in the conflict banner: overwrite Drive on purpose.
  P.driveKeepThisDevice = async function (btnEl) {
    if (!confirm('Overwrite the Google Drive copy with THIS device\'s data? Changes made on the other device and not yet downloaded here will be lost from Drive.')) return;
    this._driveBtnBusy(btnEl, true);
    try {
      const ok = await this._driveRun(async () => {
        await this._driveToken(false);
        const remote = await this._driveFindBackup();
        await this._driveUpload(remote);
      }, { rethrow: true, busyLabel: 'Uploading…' });
      if (ok) this.toast('☁️ Drive now matches this device');
    } catch (err) {
      alert('Upload failed: ' + (err && err.message ? err.message : err));
    } finally {
      this._driveBtnBusy(btnEl, false);
      this._driveRender();
    }
  };

  P.driveDownloadNow = async function (btnEl, opts = {}) {
    if (!this._driveConnected()) return;
    if (!this.cryptoKey) { this.toast('Unlock the app first', 'error'); return; }
    this._driveBtnBusy(btnEl, true);
    try {
      await this._driveToken(false);
      const remote = await this._driveFindBackup();
      if (!remote) throw new Error('No backup found in this Google account\'s Drive yet.');
      const dirty = ls.get('dirty') === '1';
      if (!opts.skipConfirm) {
        let msg = 'Download the backup from Google Drive (from ' + (remote.deviceName || 'another device') + ', ' + fmtWhen(remote.syncedAt) + ') and REPLACE all data on this device?';
        if (dirty) msg += '\n\nThis device has changes that were not uploaded. They will be replaced here — a safety copy is kept under "Local safety copies" first.';
        if (!confirm(msg)) return;
      }
      await this._driveRun(async () => {
        const resp = await this._driveApi(API + '/' + remote.fileId + '?alt=media', {}, 300000);
        if (!resp.ok) throw new Error('Drive download failed (' + resp.status + ')');
        const data = await resp.json();
        if (!data || !Array.isArray(data.vehicles) || !Array.isArray(data.entries) || !data.isEncrypted) {
          throw new Error('The Drive backup is not in the expected format.');
        }
        const rows = await this._prepareBackupRows(data, {
          passcodeMessage: 'This Google Drive backup was encrypted on another device. Enter the passcode that device used (normally the same one you use here).'
        });
        if (!rows) { this.toast('Download cancelled'); return; }
        if (dirty) await this._driveSaveSnapshot('Before Drive download');
        this._driveSuppressDirty = true;
        try { await this._replaceDataStore(rows); } finally { this._driveSuppressDirty = false; }
        if (data.drive && data.drive.currency && data.drive.currency !== this.currencySymbol) {
          await this.setCurrencyQuiet(data.drive.currency);
        }
        ls.set('lastRev', remote.rev || '');
        ls.set('lastSyncedAt', Date.now());
        ls.del('dirty'); ls.del('pause');
        this._drv().errorNote = '';
        await this._reloadAfterReplace();
        this.toast('☁️ Downloaded from Google Drive' + (dirty ? ' — your unsynced data was saved as a safety copy' : ''));
      }, { rethrow: true, busyLabel: 'Downloading…' });
    } catch (err) {
      alert('Download failed: ' + (err && err.message ? err.message : err));
    } finally {
      this._driveBtnBusy(btnEl, false);
      this._driveRender();
      this._driveRenderSnapshots();
    }
  };

  // Sets the currency symbol without a toast and without marking anything dirty.
  P.setCurrencyQuiet = async function (symbol) {
    this.currencySymbol = symbol;
    const tx = this.db.transaction('config', 'readwrite');
    tx.objectStore('config').put({ key: 'currency', symbol });
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
    const sel = document.getElementById('currencySelector');
    if (sel) sel.value = symbol;
  };

  // ============================================================================
  // Local safety copies (raw, still-encrypted records of THIS device)
  // ============================================================================
  P._driveSaveSnapshot = async function (label) {
    const tx = this.db.transaction(['vehicles', 'entries'], 'readonly');
    const vehicles = await getAll(tx, 'vehicles');
    const entries = await getAll(tx, 'entries');
    const wtx = this.db.transaction('driveSnapshots', 'readwrite');
    wtx.objectStore('driveSnapshots').add({ at: Date.now(), label, vehicles, entries, currency: this.currencySymbol });
    await new Promise((r, j) => { wtx.oncomplete = r; wtx.onerror = () => j(wtx.error); });
    // keep only the newest few
    const rtx = this.db.transaction('driveSnapshots', 'readonly');
    const keys = await new Promise((r, j) => { const q = rtx.objectStore('driveSnapshots').getAllKeys(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    keys.sort((a, b) => a - b);
    const drop = keys.slice(0, Math.max(0, keys.length - SNAPSHOT_KEEP));
    if (drop.length) {
      const dtx = this.db.transaction('driveSnapshots', 'readwrite');
      drop.forEach(k => dtx.objectStore('driveSnapshots').delete(k));
      await new Promise((r, j) => { dtx.oncomplete = r; dtx.onerror = () => j(dtx.error); });
    }
  };

  P._driveClearSnapshots = async function () {
    try {
      const tx = this.db.transaction('driveSnapshots', 'readwrite');
      tx.objectStore('driveSnapshots').clear();
      await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
    } catch (e) { /* non-fatal */ }
    this._driveRenderSnapshots();
  };

  P._driveListSnapshots = async function () {
    const tx = this.db.transaction('driveSnapshots', 'readonly');
    const rows = await getAll(tx, 'driveSnapshots');
    return rows.sort((a, b) => b.at - a.at);
  };

  P._driveRenderSnapshots = async function () {
    const wrap = document.getElementById('driveSnapshotsList');
    if (!wrap) return;
    let rows = [];
    try { rows = await this._driveListSnapshots(); } catch (e) { rows = []; }
    wrap.textContent = '';
    const section = document.getElementById('driveSnapshotsSection');
    if (section) section.classList.toggle('hidden', rows.length === 0);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 py-1.5 text-xs border-b border-gray-100 last:border-0';
      const txt = document.createElement('div');
      txt.className = 'min-w-0';
      txt.textContent = fmtWhen(r.at) + ' · ' + r.vehicles.length + ' vehicle(s), ' + r.entries.length + ' entr' + (r.entries.length === 1 ? 'y' : 'ies');
      const btns = document.createElement('div');
      btns.className = 'flex gap-1 flex-shrink-0';
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.setAttribute('data-click', 'driveRestoreSnapshot');
      restore.setAttribute('data-click-args', JSON.stringify([r.id]));
      restore.className = 'px-2 py-1 border border-gray-300 rounded hover:bg-gray-50';
      restore.textContent = 'Restore';
      const del = document.createElement('button');
      del.type = 'button';
      del.setAttribute('data-click', 'driveDeleteSnapshot');
      del.setAttribute('data-click-args', JSON.stringify([r.id]));
      del.className = 'px-2 py-1 text-red-600 border border-gray-300 rounded hover:bg-red-50';
      del.textContent = '🗑️';
      btns.append(restore, del);
      row.append(txt, btns);
      wrap.appendChild(row);
    }
  };

  P.driveRestoreSnapshot = async function (id) {
    if (!this.cryptoKey) return;
    try {
      const tx = this.db.transaction('driveSnapshots', 'readonly');
      const row = await new Promise((r, j) => { const q = tx.objectStore('driveSnapshots').get(id); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
      if (!row) { this._driveRenderSnapshots(); return; }
      const sample = row.vehicles[0] || row.entries[0];
      if (sample) {
        try { await CryptoEngine.decrypt(sample.payload, this.cryptoKey); }
        catch (e) { alert('This safety copy was made under an older passcode and can no longer be opened.'); return; }
      }
      if (!confirm('Restore the safety copy from ' + fmtWhen(row.at) + '? It replaces ALL data on this device (the current data is saved as a safety copy first). The restored data then counts as a change to upload.')) return;
      await this._driveSaveSnapshot('Before restoring a safety copy');
      await this._replaceDataStore({
        newVehicles: row.vehicles.map(v => ({ id: v.id, payload: v.payload })),
        newEntries: row.entries.map(e => ({ id: e.id, vehicleId: e.vehicleId, payload: e.payload }))
      });
      if (row.currency && row.currency !== this.currencySymbol) await this.setCurrencyQuiet(row.currency);
      await this._reloadAfterReplace();
      this.toast('Safety copy restored');
    } catch (err) {
      alert('Restore failed: ' + (err && err.message ? err.message : err));
    }
    this._driveRenderSnapshots();
  };

  P.driveDeleteSnapshot = async function (id) {
    if (!confirm('Delete this safety copy? This cannot be undone.')) return;
    const tx = this.db.transaction('driveSnapshots', 'readwrite');
    tx.objectStore('driveSnapshots').delete(id);
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
    this._driveRenderSnapshots();
  };

  // ============================================================================
  // UI
  // ============================================================================
  P._driveBtnBusy = function (btn, busy) {
    if (!btn || !btn.classList) return;
    btn.disabled = !!busy;
    btn.classList.toggle('opacity-50', !!busy);
  };

  P.showDriveModal = function () {
    this.openModal('driveModal');
    const nameInput = document.getElementById('driveDeviceName');
    if (nameInput) nameInput.value = this._driveDeviceName();
    this._driveRender();
    this._driveRenderSnapshots();
    if (this._driveConnected()) this._driveCheckQuiet(false).then(() => this._driveRender());
  };

  // What state is the sync in? -> { kind, text }
  P._driveStatus = function () {
    const d = this._drv();
    if (!this._driveConnected()) return { kind: 'off', text: 'Not connected' };
    if (d.needsReauth) return { kind: 'error', text: 'Google sign-in needed — tap Reconnect' };
    if (ls.get('pause')) return { kind: 'conflict', text: 'Auto-upload paused — Drive and this device both changed' };
    if (d.busy) return { kind: 'busy', text: d.busy };
    if (d.errorNote) return { kind: 'error', text: 'Problem: ' + d.errorNote };
    const remote = d.remote;
    const ahead = !!remote && !!remote.rev && remote.rev !== ls.get('lastRev') && remote.deviceId !== this._driveDeviceId();
    if (ahead) return { kind: 'newer', text: 'Newer data on Google Drive (from ' + (remote.deviceName || 'another device') + ', ' + fmtWhen(remote.syncedAt) + ')' };
    const dirty = ls.get('dirty') === '1';
    if (dirty) {
      if (d.primary.status === 'me' && this._driveAutoOn()) return { kind: 'busy', text: d.pending ? 'Waiting to upload…' : 'Changes not uploaded yet' };
      return { kind: 'dirty', text: 'This device has changes that are not on Google Drive yet' };
    }
    const last = ls.get('lastSyncedAt');
    return { kind: 'ok', text: 'In sync' + (last ? ' · last synced ' + fmtWhen(last) : '') };
  };

  const DOT = { off: '#94a3b8', ok: '#22c55e', busy: '#3b82f6', newer: '#f59e0b', dirty: '#f59e0b', conflict: '#ef4444', error: '#ef4444' };

  P._driveRender = function () {
    const st = this._driveStatus();
    const d = this._drv();
    const dot = document.getElementById('driveDot');
    if (dot) {
      dot.style.background = DOT[st.kind] || DOT.off;
      dot.classList.toggle('hidden', st.kind === 'off');
    }
    const btn = document.getElementById('driveBtn');
    if (btn) btn.title = 'Google Drive sync — ' + st.text;

    const connected = this._driveConnected();
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !on); };
    const setText = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    show('driveNotConnected', !connected);
    show('driveConnected', connected);
    if (!connected) return;

    setText('driveEmail', ls.get('email') || '(account)');
    const statusEl = document.getElementById('driveStatusText');
    if (statusEl) {
      statusEl.textContent = st.text;
      statusEl.style.color = (st.kind === 'error' || st.kind === 'conflict') ? '#b91c1c' : (st.kind === 'newer' || st.kind === 'dirty') ? '#b45309' : '#475569';
    }
    const nameInput = document.getElementById('driveDeviceName');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = this._driveDeviceName();

    const p = d.primary;
    let role;
    if (p.status === 'me') role = '⭐ This device is the PRIMARY. It uploads to Google Drive automatically after every change.';
    else if (p.status === 'other') role = 'Primary device: ' + p.deviceName + '. This device does not auto-upload — use Download / Upload below when something changed.';
    else if (p.status === 'none') role = 'No primary device yet. Nothing uploads automatically. Make this device (or the other one) primary.';
    else role = 'Checking primary device…';
    setText('driveRoleText', role);
    show('driveMakePrimaryBtn', p.status !== 'me' && p.status !== 'unknown');
    show('driveAutoRow', p.status === 'me');
    const toggle = document.getElementById('driveAutoSyncToggle');
    if (toggle) toggle.checked = this._driveAutoOn();

    // banners
    show('driveBannerNewer', st.kind === 'newer');
    show('driveBannerConflict', st.kind === 'conflict');
    show('driveReconnectBtn', d.needsReauth);
    const pause = (() => { try { return JSON.parse(ls.get('pause') || 'null'); } catch (e) { return null; } })();
    if (pause) setText('driveConflictText', '⚠ Auto-upload is paused: Google Drive was changed' + (pause.by ? ' by ' + pause.by : '') + ' while this device also has changes. Nothing was overwritten. Choose which copy to keep.');
  };

})();
