import crypto from 'node:crypto';
import { parseDuration } from './utils.js';

export class MemorySessionStore {
  constructor() {
    this.records = new Map();
    this.userIndex = new Map();
  }

  async get(sid) {
    const entry = this.records.get(sid);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      await this.delete(sid);
      return null;
    }
    return entry;
  }

  async set(sid, record) {
    const existing = this.records.get(sid);
    if (existing?.userId && existing.userId !== record.userId) {
      this.userIndex.get(existing.userId)?.delete(sid);
    }
    this.records.set(sid, record);
    if (record.userId !== undefined && record.userId !== null) {
      if (!this.userIndex.has(record.userId)) {
        this.userIndex.set(record.userId, new Set());
      }
      this.userIndex.get(record.userId).add(sid);
    }
  }

  async delete(sid) {
    const existing = this.records.get(sid);
    if (existing?.userId !== undefined && existing?.userId !== null) {
      this.userIndex.get(existing.userId)?.delete(sid);
    }
    this.records.delete(sid);
  }

  async listByUser(userId) {
    const sids = this.userIndex.get(userId);
    if (!sids) return [];
    const list = [];
    for (const sid of [...sids]) {
      const rec = await this.get(sid);
      if (rec) {
        list.push({
          id: sid.slice(0, 8),
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          device: rec.data?.device || 'Unknown'
        });
      }
    }
    return list;
  }

  async revokeOthers(userId, currentSid) {
    const sids = this.userIndex.get(userId);
    if (!sids) return [];
    const revoked = [];
    for (const sid of [...sids]) {
      if (sid !== currentSid) {
        await this.delete(sid);
        revoked.push(sid);
      }
    }
    return revoked;
  }
}

export class SessionManager {
  constructor(config = {}, broker = null) {
    if (!config.secret) {
      throw new Error('session.secret is required when session is enabled');
    }
    this.key = crypto.createHash('sha256').update(String(config.secret)).digest();
    this.cookieName = config.cookieName || 'servin_sid';
    this.ttlMs = parseDuration(config.ttl || '7d', 7 * 86_400_000);
    this.rolling = config.rolling ?? true;
    this.secure = config.secure ?? false;
    this.sameSite = config.sameSite || 'Lax';
    this.store = config.store || new MemorySessionStore();
    this.broker = broker;
  }

  sealSid(sid) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(sid, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
  }

  openSid(token) {
    try {
      const raw = Buffer.from(token, 'base64url');
      if (raw.length < 29) return null;
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  parseCookieSid(cookieHeader) {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      if (k === this.cookieName) {
        return this.openSid(part.slice(eq + 1).trim());
      }
    }
    return null;
  }

  buildSetCookie(token, maxAgeSec) {
    const attrs = [
      `${this.cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      `SameSite=${this.sameSite}`,
      `Max-Age=${maxAgeSec}`
    ];
    if (this.secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  async listByUser(userId) {
    return this.store.listByUser(userId);
  }

  async revokeOthers(userId, currentSid) {
    const revokedSids = await this.store.revokeOthers(userId, currentSid);
    for (const sid of revokedSids) {
      this.broker?.kickSession(sid);
    }
    return revokedSids.length;
  }

  createHandle(ctx) {
    const manager = this;
    let loaded = false;
    let dirty = false;
    let destroyed = false;
    let sid = null;
    let data = {};
    let userId = null;
    let createdAt = Date.now();
    let pendingAsync = null;

    const ensureLoadedSync = () => {
      if (loaded) return;
      loaded = true;
      const cookieHdr = ctx.req?.headers?.get('cookie');
      const parsedSid = manager.parseCookieSid(cookieHdr);
      if (parsedSid) {
        sid = parsedSid;
        if (manager.store instanceof MemorySessionStore) {
          const entry = manager.store.records.get(sid);
          if (entry && (!entry.expiresAt || entry.expiresAt > Date.now())) {
            data = { ...entry.data };
            userId = entry.userId ?? null;
            createdAt = entry.createdAt;
            if (manager.rolling) dirty = true;
          } else {
            sid = null;
          }
        }
      }
    };

    const assertMutable = () => {
      if (ctx.headersSent) {
        throw new Error('Cannot mutate wire.session after response headers have been sent');
      }
    };

    const apiMethods = {
      async rotate() {
        assertMutable();
        ensureLoadedSync();
        if (sid) {
          await manager.store.delete(sid);
          manager.broker?.kickSession(sid);
        }
        sid = crypto.randomUUID();
        createdAt = Date.now();
        dirty = true;
        destroyed = false;
      },
      bind(uid) {
        assertMutable();
        ensureLoadedSync();
        if (!sid) sid = crypto.randomUUID();
        userId = uid;
        dirty = true;
      }
    };

    const proxy = new Proxy({}, {
      get(_, prop) {
        if (prop in apiMethods) return apiMethods[prop];
        if (prop === 'id') {
          ensureLoadedSync();
          return sid;
        }
        ensureLoadedSync();
        return data[prop];
      },
      set(_, prop, value) {
        assertMutable();
        ensureLoadedSync();
        if (!sid) sid = crypto.randomUUID();
        data[prop] = value;
        dirty = true;
        destroyed = false;
        return true;
      },
      deleteProperty(_, prop) {
        assertMutable();
        ensureLoadedSync();
        delete data[prop];
        dirty = true;
        return true;
      },
      ownKeys() {
        ensureLoadedSync();
        return Reflect.ownKeys(data);
      },
      getOwnPropertyDescriptor(_, prop) {
        ensureLoadedSync();
        return Object.getOwnPropertyDescriptor(data, prop);
      }
    });

    return {
      proxy,
      get sid() {
        ensureLoadedSync();
        return sid;
      },
      destroy() {
        assertMutable();
        ensureLoadedSync();
        destroyed = true;
        dirty = true;
        data = {};
        userId = null;
        if (sid) {
          const oldSid = sid;
          sid = null;
          pendingAsync = manager.store.delete(oldSid);
          manager.broker?.kickSession(oldSid);
        }
      },
      replace(newObj) {
        assertMutable();
        ensureLoadedSync();
        if (!sid) sid = crypto.randomUUID();
        data = { ...newObj };
        dirty = true;
        destroyed = false;
      },
      async preload() {
        if (loaded) return;
        loaded = true;
        const cookieHdr = ctx.req?.headers?.get('cookie');
        const parsedSid = manager.parseCookieSid(cookieHdr);
        if (parsedSid) {
          const entry = await manager.store.get(parsedSid);
          if (entry) {
            sid = parsedSid;
            data = { ...entry.data };
            userId = entry.userId ?? null;
            createdAt = entry.createdAt;
            if (manager.rolling) dirty = true;
          }
        }
      },
      async commit(headers) {
        if (pendingAsync) await pendingAsync;
        if (!dirty) return;
        if (destroyed) {
          headers.append('Set-Cookie', manager.buildSetCookie('', 0));
          return;
        }
        if (!sid) sid = crypto.randomUUID();
        const now = Date.now();
        await manager.store.set(sid, {
          userId,
          data,
          createdAt,
          updatedAt: now,
          expiresAt: now + manager.ttlMs
        });
        const sealed = manager.sealSid(sid);
        headers.append('Set-Cookie', manager.buildSetCookie(sealed, Math.floor(manager.ttlMs / 1000)));
      }
    };
  }
}