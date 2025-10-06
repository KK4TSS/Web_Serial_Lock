// serial-lock.js  Single hardware tab lock using BroadcastChannel + localStorage heartbeat

const CHANNEL = 'serial-lock';
const STORAGE_KEY = 'serialLock.lockId';
const HEARTBEAT_KEY = 'serialLock.heartbeat';
const HEARTBEAT_MS = 1500;
const HEARTBEAT_COMMIT_N = 5;
const STALE_AFTER_MS = 15000;
const TAKEOVER_WAIT_MS = 3000;
const ELECTION_WINDOW_MS = 160;

export class SerialLock {
  constructor({ onBecameOwner, onLostOwnership, onOwnerChanged, onTakeoverRequested, debug=false } = {}) {
    this.debug = debug;
    this.channel = new BroadcastChannel(CHANNEL);
    this.lockId = crypto.randomUUID();
    this.isOwner = false;
    this.heartbeatTimer = null;
    this._lastOwnerNotified = undefined;
    this._candidates = new Set();
    this._hbCount = 0;

    this.onBecameOwner = onBecameOwner || (()=>{});
    this.onLostOwnership = onLostOwnership || (()=>{});
    this.onOwnerChanged = onOwnerChanged || (()=>{});
    this.onTakeoverRequested = onTakeoverRequested || (()=>{});

    this._onMessage = (ev) => this.#onMessage(ev.data);
    this._onStorage = (e) => this.#onStorage(e);
    this._onBeforeUnload = () => this.release({ announce:true });

    this.channel.onmessage = this._onMessage;
    window.addEventListener('storage', this._onStorage);
    window.addEventListener('beforeunload', this._onBeforeUnload);
  }

  log(...args){ if (this.debug) console.log('[serial-lock]', ...args); }
  #sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  #jitter(min=25, max=125){ return Math.floor(Math.random() * (max - min + 1)) + min; }

  async claim() {
    if (this.isOwner) return true;
    const current = localStorage.getItem(STORAGE_KEY);
    const lastBeat = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
    const now = Date.now();

    if (!current || (now - lastBeat) > STALE_AFTER_MS) {
      await this.#sleep(this.#jitter());
      const current2 = localStorage.getItem(STORAGE_KEY);
      const lastBeat2 = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
      const now2 = Date.now();
      if (!current2 || (now2 - lastBeat2) > STALE_AFTER_MS) {
        localStorage.setItem(STORAGE_KEY, this.lockId);
        await this.#sleep(this.#jitter());
        if (localStorage.getItem(STORAGE_KEY) === this.lockId) {
          this.#becomeOwner();
          return true;
        }
      }
    }
    return false;
  }

  async requestTakeover() {
    if (this.isOwner) return true;
    this.channel.postMessage({ type:'request-release', from:this.lockId, at:Date.now() });
    await this.#sleep(TAKEOVER_WAIT_MS);

    this._candidates.clear();
    this.channel.postMessage({ type:'takeover-candidate', id:this.lockId, at:Date.now() });
    await this.#sleep(ELECTION_WINDOW_MS);

    const maxId = [...this._candidates, this.lockId].sort((a,b)=>a.localeCompare(b)).pop();
    if (maxId !== this.lockId) return false;

    const lastBeatA = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
    const nowA = Date.now();
    const ownerA = localStorage.getItem(STORAGE_KEY);
    if (ownerA && (nowA - lastBeatA) <= STALE_AFTER_MS) return false;

    await this.#sleep(this.#jitter());

    const lastBeatB = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
    const nowB = Date.now();
    const ownerB = localStorage.getItem(STORAGE_KEY);
    if (ownerB && (nowB - lastBeatB) <= STALE_AFTER_MS) return false;

    localStorage.setItem(STORAGE_KEY, this.lockId);
    await this.#sleep(this.#jitter());
    if (localStorage.getItem(STORAGE_KEY) === this.lockId) {
      this.#becomeOwner();
      return true;
    }
    return this.isOwner;
  }

  release({ announce=false } = {}) {
    if (!this.isOwner) return;
    this.isOwner = false;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (localStorage.getItem(STORAGE_KEY) === this.lockId)
      localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(HEARTBEAT_KEY);
    if (announce) this.channel.postMessage({ type:'released', from:this.lockId, at:Date.now() });
    this.onLostOwnership();
  }

  destroy() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    window.removeEventListener('storage', this._onStorage);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    this.channel.onmessage = null;
    try { this.channel.close(); } catch {}
  }

  #startHeartbeat() {
    const beat = () => {
      this.channel.postMessage({ type:'hb', from:this.lockId, at:Date.now() });
      this._hbCount = (this._hbCount + 1) % HEARTBEAT_COMMIT_N;
      if (this._hbCount === 0) localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
    };
    beat();
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  #becomeOwner() {
    this.isOwner = true;
    this.#startHeartbeat();
    this.channel.postMessage({ type:'owner-changed', owner:this.lockId, at:Date.now() });
    this.onBecameOwner();
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hb') return;
    if (msg.type === 'takeover-candidate' && msg.id && msg.id !== this.lockId) {
      this._candidates.add(msg.id);
      return;
    }
    if (msg.from === this.lockId) return;
    switch (msg.type) {
      case 'owner-changed':
        if (this._lastOwnerNotified !== msg.owner) {
          this._lastOwnerNotified = msg.owner || null;
          this.onOwnerChanged?.(msg.owner || null);
        }
        break;
      case 'request-release':
        if (this.isOwner) {
          this.onTakeoverRequested?.(msg.from);
          this.release({ announce:true });
        }
        break;
      case 'released':
        if (this._lastOwnerNotified !== null) {
          this._lastOwnerNotified = null;
          this.onOwnerChanged?.(null);
        }
        break;
    }
  }

  #onStorage(e) {
    if (e.key === STORAGE_KEY) {
      const current = e.newValue || null;
      if (this.isOwner && current !== this.lockId) {
        this.release();
      }
      if (this._lastOwnerNotified !== current) {
        this._lastOwnerNotified = current;
        this.onOwnerChanged?.(current);
      }
    }
  }
}

