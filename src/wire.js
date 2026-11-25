import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  FileStreamResponse,
  HtmlResponse,
  escapeHtml,
  parseMultipartStream
} from './utils.js';

export const wireStorage = new AsyncLocalStorage();

const reactionRegistry = new WeakMap();

export function reactTo(targetFn, observerFn) {
  if (typeof targetFn !== 'function' || typeof observerFn !== 'function') {
    throw new TypeError('reactTo(targetFn, observerFn) requires two functions');
  }
  const list = reactionRegistry.get(targetFn) || [];
  list.push(observerFn);
  reactionRegistry.set(targetFn, list);
  return () => {
    const idx = list.indexOf(observerFn);
    if (idx !== -1) list.splice(idx, 1);
  };
}

export function getReactions(targetFn) {
  return reactionRegistry.get(targetFn) || [];
}

export class ServinAbortError extends Error {
  constructor(status = 400, message = 'Request aborted') {
    super(message);
    this.name = 'ServinAbortError';
    this.status = status;
  }
}

function renderInterpolated(val) {
  if (val instanceof HtmlResponse) return val.html;
  if (Array.isArray(val)) return val.map(renderInterpolated).join('');
  return escapeHtml(val);
}

export function createRequestContext({
  req,
  method,
  url,
  signal,
  sessionManager,
  broker,
  deferTracker
}) {
  const outgoingHeaders = new Headers();
  const undoStack = [];
  const debugLogs = [];
  const timings = [];
  const startTime = performance.now();
  const requestId = crypto.randomUUID().slice(0, 8);

  const headersProxy = new Proxy(outgoingHeaders, {
    get(target, prop) {
      if (prop === 'get') {
        return (key) => target.get(key) ?? req?.headers?.get(key) ?? null;
      }
      if (prop === 'has') {
        return (key) => target.has(key) || Boolean(req?.headers?.has(key));
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });

  const ctx = {
    requestId,
    startTime,
    req,
    method: (method || req?.method || 'GET').toUpperCase(),
    url: url || (req ? new URL(req.url) : new URL('http://localhost/')),
    signal: signal || req?.signal || new AbortController().signal,
    headersProxy,
    outgoingHeaders,
    statusCode: 200,
    statusExplicit: false,
    headersSent: false,
    undoStack,
    debugLogs,
    timings,
    costPoints: 1,
    costExplicit: false,
    isSimulated: req?.headers?.get('x-simulate')?.toLowerCase() === 'true',
    sessionHandle: null,
    sessionManager,
    broker,
    deferTracker
  };

  if (sessionManager) {
    ctx.sessionHandle = sessionManager.createHandle(ctx);
  }

  return ctx;
}

export async function runUndoStack(ctx) {
  while (ctx.undoStack.length > 0) {
    const fn = ctx.undoStack.pop();
    try {
      await fn();
    } catch (err) {
      console.error(`[servin][${ctx.requestId}] Undo compensation failed:`, err);
    }
  }
}

export function flushDebugLogs(ctx, err) {
  if (ctx.debugLogs.length === 0) return;
  console.error(`\n[servin][${ctx.requestId}] Error-Triggered Debug Trace (${ctx.method} ${ctx.url.pathname}):`);
  for (const entry of ctx.debugLogs) {
    console.error(`  +${entry.offsetMs.toFixed(1)}ms [${entry.level}] ${entry.msg}`, entry.meta ?? '');
  }
  if (err) console.error('  Failure:', err.stack || err.message || err);
}

function getCtx() {
  const ctx = wireStorage.getStore();
  if (!ctx) {
    throw new Error('`wire` accessed outside of an active servin execution context');
  }
  return ctx;
}

export const wire = {
  get req() {
    return getCtx().req;
  },
  get method() {
    return getCtx().method;
  },
  get url() {
    return getCtx().url;
  },
  get headers() {
    return getCtx().headersProxy;
  },
  get stream() {
    return getCtx().req?.body ?? null;
  },
  get signal() {
    return getCtx().signal;
  },
  status(code) {
    const ctx = getCtx();
    ctx.statusCode = code;
    ctx.statusExplicit = true;
  },
  abort(status = 400, message = 'Aborted') {
    throw new ServinAbortError(status, message);
  },
  undo(fn) {
    if (typeof fn === 'function') {
      getCtx().undoStack.push(fn);
    }
  },
  defer(fn) {
    const ctx = getCtx();
    if (typeof fn !== 'function') return;
    const task = Promise.resolve().then(() => fn()).catch((err) => {
      console.error(`[servin][${ctx.requestId}] Deferred task error:`, err);
    });
    if (ctx.deferTracker) ctx.deferTracker.track(task);
  },
  html(strings, ...values) {
    if (Array.isArray(strings) && Array.isArray(strings.raw)) {
      let out = strings[0];
      for (let i = 0; i < values.length; i++) {
        out += renderInterpolated(values[i]) + strings[i + 1];
      }
      return new HtmlResponse(out);
    }
    return new HtmlResponse(strings);
  },
  file(filePath) {
    return new FileStreamResponse(filePath);
  },
  multipart(opts = {}) {
    const ctx = getCtx();
    const ct = ctx.req?.headers?.get('content-type') || '';
    if (!ctx.req?.body) {
      throw new ServinAbortError(400, 'Missing request body stream for multipart');
    }
    return parseMultipartStream(ctx.req.body, ct, opts);
  },
  get session() {
    const ctx = getCtx();
    if (!ctx.sessionHandle) {
      throw new Error('Session is not configured in serve({ session: { secret } })');
    }
    return ctx.sessionHandle.proxy;
  },
  set session(val) {
    const ctx = getCtx();
    if (!ctx.sessionHandle) {
      throw new Error('Session is not configured in serve({ session: { secret } })');
    }
    if (val === null) {
      ctx.sessionHandle.destroy();
    } else if (typeof val === 'object') {
      ctx.sessionHandle.replace(val);
    }
  },
  get sessions() {
    const ctx = getCtx();
    if (!ctx.sessionManager) {
      throw new Error('Session is not configured in serve({ session: { secret } })');
    }
    return {
      list: (userId) => ctx.sessionManager.listByUser(userId),
      revokeOthers: (userId) => ctx.sessionManager.revokeOthers(userId, ctx.sessionHandle?.sid)
    };
  },
  publish(topic, data) {
    const ctx = getCtx();
    ctx.broker?.publish(topic, data);
  },
  cost(points) {
    const ctx = getCtx();
    ctx.costPoints = Number(points) || 0;
    ctx.costExplicit = true;
  },
  log: {
    debug(msg, meta) {
      const ctx = wireStorage.getStore();
      if (!ctx) return;
      ctx.debugLogs.push({
        level: 'DEBUG',
        offsetMs: performance.now() - ctx.startTime,
        msg,
        meta
      });
    },
    info(msg, meta) {
      const ctx = wireStorage.getStore();
      console.log(`[servin][${ctx?.requestId ?? 'sys'}] ${msg}`, meta ?? '');
    }
  },
  mark(label) {
    const ctx = getCtx();
    const t0 = performance.now();
    return () => {
      ctx.timings.push({ label, dur: performance.now() - t0 });
    };
  }
};