import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  wire,
  wireStorage,
  createRequestContext,
  runUndoStack,
  flushDebugLogs,
  getReactions,
  ServinAbortError,
  ServinRedirect
} from './wire.js';
import { SessionManager, MemorySessionStore } from './session.js';
import {
  compileDomainTree,
  matchDomainRoute,
  generateVirtualClientModule
} from './tree.js';
import {
  WebSocketBroker,
  createLinearSocket,
  performWsHandshake
} from './websocket.js';
import {
  parseDuration,
  applyFieldMask,
  applyRedaction,
  validateExpect,
  FileStreamResponse,
  HtmlResponse,
  buildFileHttpResponse,
  buildStaticHttpResponse,
  createLagMonitor
} from './utils.js';

function toWebRequest(nodeReq, host, port, signal) {
  const proto = nodeReq.socket?.encrypted ? 'https' : 'http';
  const reqHost = nodeReq.headers.host || `${host}:${port}`;
  const url = new URL(nodeReq.url || '/', `${proto}://${reqHost}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (v !== undefined) {
      headers.set(k, v);
    }
  }

  const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD';
  return new Request(url, {
    method: nodeReq.method,
    headers,
    body: hasBody ? Readable.toWeb(nodeReq) : null,
    duplex: hasBody ? 'half' : undefined,
    signal
  });
}

async function parseBodyPayload(req, webhookConfig) {
  const rawBuffer = Buffer.from(await req.arrayBuffer());

  if (webhookConfig) {
    const sigHeader = req.headers.get(webhookConfig.header);
    if (!sigHeader) {
      throw new ServinAbortError(401, 'Missing webhook signature header');
    }
    const algo = webhookConfig.algo || 'sha256';
    const expected = crypto
      .createHmac(algo, webhookConfig.secret)
      .update(rawBuffer)
      .digest('hex');

    const cleanSig = sigHeader.replace(/^sha\d+=/i, '');
    const bufA = Buffer.from(expected, 'utf8');
    const bufB = Buffer.from(cleanSig, 'utf8');

    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      throw new ServinAbortError(401, 'Invalid webhook HMAC signature');
    }
  }

  if (rawBuffer.length === 0) return {};
  const text = rawBuffer.toString('utf8');
  const ct = req.headers.get('content-type') || '';

  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function serve(config = {}) {
  const port = config.port ?? 3000;
  const host = config.host ?? '127.0.0.1';
  const silent = config.silent ?? false;
  const routes = compileDomainTree(config.api || {}, config.types || {}, config.static || null);
  const virtualClientCode = generateVirtualClientModule(routes);

  const broker = new WebSocketBroker();
  const sessionManager = config.session ? new SessionManager(config.session, broker) : null;
  const lagMonitor = createLagMonitor(config.lagThresholdMs ?? 60);
  const rateBuckets = new Map();
  const activeDefers = new Set();
  const recordedTests = new Map();

  const deferTracker = {
    track(promise) {
      activeDefers.add(promise);
      promise.finally(() => activeDefers.delete(promise));
    }
  };

  function emitAccessLog(info) {
    if (silent || config.accessLog === false) return;

    if (typeof config.accessLog === 'function') {
      const customLine = config.accessLog(info);
      if (typeof customLine === 'string' && customLine.length > 0) {
        console.log(customLine);
      }
      return;
    }

    const tags = [];
    if (info.cached) tags.push('CACHE');
    if (info.simulated) tags.push('SIMULATE');
    const suffix = tags.length > 0 ? ` [${tags.join(',')}]` : '';

    console.log(
      `[servin] ${info.method} ${info.url.pathname}${info.url.search} ${info.status} ${info.durationMs.toFixed(1)}ms${suffix}`
    );
  }

  function applyCorsHeaders(req, headers) {
    if (!config.origins || config.origins.length === 0) return;
    const origin = req.headers.get('origin');
    if (!origin) return;
    if (config.origins.includes('*') || config.origins.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Vary', 'Origin');
    }
  }

  function findErrorHandler(status) {
    const errorsCfg = config.errors;
    if (!errorsCfg || typeof errorsCfg !== 'object') return null;

    if (Object.prototype.hasOwnProperty.call(errorsCfg, status)) {
      return errorsCfg[status];
    }
    const statusStr = String(status);
    if (Object.prototype.hasOwnProperty.call(errorsCfg, statusStr)) {
      return errorsCfg[statusStr];
    }
    if (status >= 400 && status < 500 && errorsCfg['4xx']) {
      return errorsCfg['4xx'];
    }
    if (status >= 500 && errorsCfg['5xx']) {
      return errorsCfg['5xx'];
    }
    return errorsCfg.default ?? null;
  }

  async function buildErrorResponse({ webReq, status, defaultPayload, existingCtx = null, rawError = null, extraHeaders = null }) {
    const handler = findErrorHandler(status);
    const url = existingCtx?.url || new URL(webReq.url);
    const method = existingCtx?.method || webReq.method.toUpperCase();

    if (!handler) {
      const headers = existingCtx?.outgoingHeaders || new Headers();
      if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
      }
      if (status === 405 && !defaultPayload) {
        return new Response(null, { status: 405, headers });
      }
      return Response.json(defaultPayload || { error: 'Error' }, { status, headers });
    }

    const ctx = existingCtx || createRequestContext({
      req: webReq,
      method,
      url,
      signal: webReq.signal,
      sessionManager,
      broker,
      deferTracker
    });

    if (!existingCtx) {
      applyCorsHeaders(webReq, ctx.outgoingHeaders);
    }
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        ctx.outgoingHeaders.set(k, v);
      }
    }

    ctx.statusCode = status;
    ctx.statusExplicit = false;

    const runCustomizer = async () => {
      try {
        const result = typeof handler === 'function'
          ? await handler({
            status,
            message: defaultPayload?.error || '',
            details: defaultPayload?.details,
            path: url.pathname,
            method,
            error: rawError,
            wire
          })
          : handler;

        if (!ctx.isSimulated) {
          await ctx.sessionHandle?.commit(ctx.outgoingHeaders).catch(() => { });
        }

        if (result instanceof Response) return result;

        if (result instanceof FileStreamResponse) {
          const fileRes = await buildFileHttpResponse(result, webReq.headers, {
            method,
            statusOverride: ctx.statusCode
          });
          ctx.outgoingHeaders.forEach((v, k) => {
            if (!fileRes.headers.has(k)) fileRes.headers.set(k, v);
          });
          return fileRes;
        }

        if (result instanceof HtmlResponse) {
          if (!ctx.outgoingHeaders.has('content-type')) {
            ctx.outgoingHeaders.set('Content-Type', 'text/html; charset=utf-8');
          }
          return new Response(result.html, {
            status: ctx.statusCode,
            headers: ctx.outgoingHeaders
          });
        }

        if (typeof result === 'string') {
          if (!ctx.outgoingHeaders.has('content-type')) {
            ctx.outgoingHeaders.set('Content-Type', 'text/plain; charset=utf-8');
          }
          return new Response(result, {
            status: ctx.statusCode,
            headers: ctx.outgoingHeaders
          });
        }

        if (result === null || result === undefined) {
          return new Response(null, { status: ctx.statusCode, headers: ctx.outgoingHeaders });
        }

        return Response.json(result, {
          status: ctx.statusCode,
          headers: ctx.outgoingHeaders
        });
      } catch (err) {
        if (err instanceof ServinRedirect) {
          if (!ctx.isSimulated) {
            await ctx.sessionHandle?.commit(ctx.outgoingHeaders).catch(() => { });
          }
          ctx.outgoingHeaders.set('Location', err.location);
          return new Response(null, { status: err.status, headers: ctx.outgoingHeaders });
        }
        return Response.json(defaultPayload || { error: 'Internal Server Error' }, {
          status,
          headers: ctx.outgoingHeaders
        });
      }
    };

    return existingCtx ? runCustomizer() : wireStorage.run(ctx, runCustomizer);
  }

  async function writeSnapshot(ctx, route, err) {
    if (!config.snapshotOnError) return;
    try {
      await fsp.mkdir(config.snapshotOnError, { recursive: true });
      const fileName = `err-${new Date().toISOString().replace(/[:.]/g, '-')}-${ctx.requestId}.json`;
      const snapshot = {
        timestamp: new Date().toISOString(),
        dotPath: route?.dotPath || null,
        method: ctx.method,
        url: ctx.url.toString(),
        headers: Object.fromEntries(ctx.req.headers.entries()),
        error: { message: err.message, stack: err.stack }
      };
      await fsp.writeFile(
        path.join(config.snapshotOnError, fileName),
        JSON.stringify(snapshot, null, 2),
        'utf8'
      );
    } catch (snapErr) {
      console.error('[servin] Failed writing error snapshot:', snapErr);
    }
  }

  async function recordSyntheticTest(route, args, result, status) {
    if (!config.synthesizeTests || !route || status >= 500) return;
    const key = `${route.dotPath}:${status}`;
    if (recordedTests.has(key)) return;

    const urlPath = '/' + route.segments
      .map((s, idx) => (s.type === 'static' ? s.value : encodeURIComponent(String(args[idx] ?? '1'))))
      .join('/');

    recordedTests.set(key, {
      dotPath: route.dotPath,
      method: route.verbs[0],
      urlPath,
      status,
      hasBody: ['POST', 'PUT', 'PATCH'].includes(route.verbs[0]),
      bodyArg: ['POST', 'PUT', 'PATCH'].includes(route.verbs[0]) ? args[route.paramNames.length] : undefined,
      expected: result
    });

    const lines = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      `const BASE_URL = process.env.TEST_BASE_URL || 'http://${host}:${port}';`,
      ''
    ];

    for (const item of recordedTests.values()) {
      lines.push(`test('${item.dotPath} (${item.method} ${item.urlPath}) -> ${item.status}', async () => {`);
      const fetchOpts = [`method: '${item.method}'`];
      if (item.hasBody && item.bodyArg !== undefined) {
        fetchOpts.push(`headers: { 'Content-Type': 'application/json' }`);
        fetchOpts.push(`body: JSON.stringify(${JSON.stringify(item.bodyArg)})`);
      }
      lines.push(`  const res = await fetch(\`\${BASE_URL}${item.urlPath}\`, { ${fetchOpts.join(', ')} });`);
      lines.push(`  assert.equal(res.status, ${item.status});`);
      if (item.expected !== null && item.expected !== undefined && typeof item.expected === 'object') {
        lines.push(`  const body = await res.json();`);
        lines.push(`  assert.deepEqual(body, ${JSON.stringify(item.expected)});`);
      }
      lines.push('});', '');
    }

    try {
      await fsp.mkdir(path.dirname(path.resolve(config.synthesizeTests)), { recursive: true });
      await fsp.writeFile(config.synthesizeTests, lines.join('\n'), 'utf8');
    } catch (e) {
      console.error('[servin] Failed writing synthesized test:', e);
    }
  }

  async function executeHttp(webReq, reqMeta) {
    const url = new URL(webReq.url);
    const method = webReq.method.toUpperCase();

    if (method === 'GET' && url.pathname === '/@client.js') {
      const headers = new Headers({
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      applyCorsHeaders(webReq, headers);
      return new Response(virtualClientCode, { status: 200, headers });
    }

    const match = matchDomainRoute(routes, method, url.pathname);

    if (method === 'OPTIONS' && match.status === 405) {
      const headers = new Headers({
        Allow: match.allow,
        'Access-Control-Allow-Methods': `${match.allow}, OPTIONS`,
        'Access-Control-Allow-Headers': webReq.headers.get('access-control-request-headers') || 'Content-Type, Authorization, Idempotency-Key, X-Simulate'
      });
      applyCorsHeaders(webReq, headers);
      return new Response(null, { status: 204, headers });
    }

    if (match.status === 404) {
      return buildErrorResponse({
        webReq,
        status: 404,
        defaultPayload: { error: 'Not Found' }
      });
    }
    if (match.status === 405) {
      return buildErrorResponse({
        webReq,
        status: 405,
        defaultPayload: null,
        extraHeaders: { Allow: match.allow }
      });
    }

    const { route, params } = match;

    if (route.meta.priority === 'low' && lagMonitor.isOverloaded()) {
      return buildErrorResponse({
        webReq,
        status: 503,
        defaultPayload: { error: 'Service temporarily overloaded' },
        extraHeaders: { 'Retry-After': '2' }
      });
    }

    const ctx = createRequestContext({
      req: webReq,
      method,
      url,
      signal: webReq.signal,
      sessionManager,
      broker,
      deferTracker
    });

    reqMeta.requestId = ctx.requestId;
    reqMeta.simulated = ctx.isSimulated;

    applyCorsHeaders(webReq, ctx.outgoingHeaders);

    if (route.meta.sunset) {
      ctx.outgoingHeaders.set('Deprecation', 'true');
      ctx.outgoingHeaders.set('Sunset', new Date(route.meta.sunset).toUTCString());
    }

    return wireStorage.run(ctx, async () => {
      let activeLimiterBucket = null;
      let limiterMax = 0;

      try {
        if (ctx.sessionHandle && !(sessionManager.store instanceof MemorySessionStore)) {
          await ctx.sessionHandle.preload();
        }

        for (const guardFn of route.guards) {
          await guardFn();
        }

        // Handle declarative RedirectDescriptor
        if (route.redirectDescriptor) {
          const paramValues = route.paramNames.map((name) => params[name]);
          const queryObj = Object.fromEntries(url.searchParams.entries());
          const targetUrl = typeof route.redirectDescriptor.target === 'function'
            ? await route.redirectDescriptor.target(...paramValues, queryObj)
            : route.redirectDescriptor.target;

          if (!ctx.isSimulated) {
            await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
          }
          ctx.outgoingHeaders.set('Location', String(targetUrl));
          return new Response(null, {
            status: route.redirectDescriptor.status,
            headers: ctx.outgoingHeaders
          });
        }

        // Handle StaticRouteDescriptor (file or folder)
        if (route.staticDescriptor) {
          const staticRes = await buildStaticHttpResponse(
            route.staticDescriptor,
            params.subpath || '',
            webReq.headers,
            method
          );

          if (staticRes.errorStatus) {
            return buildErrorResponse({
              webReq,
              status: staticRes.errorStatus,
              defaultPayload: { error: staticRes.message },
              existingCtx: ctx
            });
          }

          if (!ctx.isSimulated) {
            await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
          }
          ctx.outgoingHeaders.forEach((v, k) => {
            if (!staticRes.response.headers.has(k)) {
              staticRes.response.headers.set(k, v);
            }
          });
          return staticRes.response;
        }

        const paramValues = route.paramNames.map((name) => params[name]);
        const queryObj = Object.fromEntries(url.searchParams.entries());
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const contentType = webReq.headers.get('content-type') || '';
        const isMultipart = contentType.toLowerCase().startsWith('multipart/form-data');

        let payload;
        const shouldParseBody = hasBody && !route.meta.rawBody && (!isMultipart || Boolean(route.meta.webhook));

        if (shouldParseBody) {
          payload = await parseBodyPayload(webReq, route.meta.webhook);
          if (route.meta.expect) {
            const validationErrors = validateExpect(payload, route.meta.expect);
            if (validationErrors.length > 0) {
              if (!ctx.isSimulated) await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
              return buildErrorResponse({
                webReq,
                status: 422,
                defaultPayload: { error: 'Validation Failed', details: validationErrors },
                existingCtx: ctx
              });
            }
          }
        }

        if (route.meta.limit) {
          const { max, window: winStr, key: keyFn } = route.meta.limit;
          const windowMs = parseDuration(winStr, 60_000);
          const customKey = typeof keyFn === 'function' ? keyFn(payload) : null;
          const bucketKey = `${route.nodeId}:${customKey || webReq.headers.get('x-forwarded-for') || 'global'}`;
          const now = Date.now();

          let bucket = rateBuckets.get(bucketKey);
          if (!bucket || bucket.resetAt <= now) {
            bucket = { remaining: max, resetAt: now + windowMs };
            rateBuckets.set(bucketKey, bucket);
          }

          if (bucket.remaining <= 0) {
            const retrySec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
            return buildErrorResponse({
              webReq,
              status: 429,
              defaultPayload: { error: 'Too Many Requests' },
              existingCtx: ctx,
              extraHeaders: { 'Retry-After': String(retrySec) }
            });
          }

          activeLimiterBucket = bucket;
          limiterMax = max;
        }

        const handlerArgs = shouldParseBody
          ? [...paramValues, payload, queryObj]
          : [...paramValues, queryObj];

        // SSE Async Generator Streaming
        if (route.isAsyncGen) {
          if (!ctx.isSimulated) await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
          ctx.outgoingHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
          ctx.outgoingHeaders.set('Cache-Control', 'no-cache');
          ctx.outgoingHeaders.set('Connection', 'keep-alive');
          ctx.headersSent = true;

          const iterator = route.handler(...handlerArgs);
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await iterator.next();
                if (done) {
                  controller.close();
                  return;
                }
                const frame = `data: ${JSON.stringify(value)}\n\n`;
                controller.enqueue(new TextEncoder().encode(frame));
              } catch (err) {
                controller.error(err);
              }
            },
            async cancel() {
              await iterator.return?.();
              await runUndoStack(ctx);
            }
          });

          return new Response(stream, { status: ctx.statusCode, headers: ctx.outgoingHeaders });
        }

        // Idempotency Check for Mutations
        const idemHeader = webReq.headers.get('idempotency-key');
        const idemKey = route.nodeIdempotency && idemHeader ? `${route.nodeId}:${idemHeader}` : null;
        if (idemKey && !ctx.isSimulated) {
          const cachedIdem = route.nodeIdempotency.get(idemKey);
          if (cachedIdem && cachedIdem.expiresAt > Date.now()) {
            const stored = await cachedIdem.promise;
            return Response.json(stored.body, {
              status: stored.status,
              headers: ctx.outgoingHeaders
            });
          }
        }

        // Self-Invalidating Cache Lookup for GET
        const cacheKey = route.nodeCache && method === 'GET'
          ? `${route.nodeId}:${JSON.stringify(params)}:${url.search}`
          : null;

        if (cacheKey) {
          const cached = route.nodeCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            reqMeta.cached = true;
            if (!ctx.isSimulated) await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
            return Response.json(cached.value, { status: 200, headers: ctx.outgoingHeaders });
          }
        }

        const executeHandler = async () => {
          const out = await route.handler(...handlerArgs);
          if (ctx.isSimulated) {
            await runUndoStack(ctx);
          } else {
            for (const observer of getReactions(route.handler)) {
              const reactionTask = Promise.resolve().then(() =>
                observer({ input: handlerArgs, output: out, wire })
              );
              deferTracker.track(reactionTask);
            }
          }
          return out;
        };

        let rawResult;
        if (route.nodeInFlight && method === 'GET') {
          const coalKey = `${route.nodeId}:${JSON.stringify(params)}:${url.search}`;
          let sharedPromise = route.nodeInFlight.get(coalKey);
          if (!sharedPromise) {
            sharedPromise = executeHandler().finally(() => route.nodeInFlight.delete(coalKey));
            route.nodeInFlight.set(coalKey, sharedPromise);
          }
          rawResult = await sharedPromise;
        } else if (idemKey && !ctx.isSimulated) {
          const ttlMs = parseDuration(route.meta.idempotent, 600_000);
          const workPromise = executeHandler().then((res) => ({
            status: ctx.statusCode,
            body: res
          }));
          route.nodeIdempotency.set(idemKey, {
            expiresAt: Date.now() + ttlMs,
            promise: workPromise
          });
          const settled = await workPromise;
          rawResult = settled.body;
        } else {
          rawResult = await executeHandler();
        }

        // Invalidate node cache and ancestor caches on successful mutations
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !ctx.isSimulated) {
          if (route.nodeCache) {
            const prefix = `${route.nodeId}:${JSON.stringify(params)}:`;
            for (const k of route.nodeCache.keys()) {
              if (k.startsWith(prefix) || Object.keys(params).length === 0) {
                route.nodeCache.delete(k);
              }
            }
          }
          if (route.ancestorCaches && route.ancestorCaches.length > 0) {
            for (const ancCache of route.ancestorCaches) {
              ancCache.clear();
            }
          }
        }

        if (!ctx.isSimulated) {
          await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
        }
        ctx.headersSent = true;

        if (ctx.timings.length > 0) {
          const timingHeader = ctx.timings
            .map((t) => `${t.label};dur=${t.dur.toFixed(2)}`)
            .join(', ');
          ctx.outgoingHeaders.set('Server-Timing', timingHeader);
        }

        if (rawResult instanceof Response) {
          return rawResult;
        }

        if (rawResult instanceof FileStreamResponse) {
          const fileRes = await buildFileHttpResponse(rawResult, webReq.headers, {
            method,
            returnMissing: true
          });
          if (!fileRes) {
            return buildErrorResponse({
              webReq,
              status: 404,
              defaultPayload: { error: 'File Not Found' },
              existingCtx: ctx
            });
          }
          return fileRes;
        }

        if (rawResult instanceof HtmlResponse) {
          if (!ctx.outgoingHeaders.has('content-type')) {
            ctx.outgoingHeaders.set('Content-Type', 'text/html; charset=utf-8');
          }
          await recordSyntheticTest(route, handlerArgs, rawResult.html, ctx.statusCode);
          return new Response(rawResult.html, {
            status: ctx.statusCode,
            headers: ctx.outgoingHeaders
          });
        }

        if (rawResult === null || rawResult === undefined) {
          const status = ctx.statusExplicit ? ctx.statusCode : 204;
          await recordSyntheticTest(route, handlerArgs, null, status);
          return new Response(null, { status, headers: ctx.outgoingHeaders });
        }

        if (typeof rawResult === 'string') {
          if (!ctx.outgoingHeaders.has('content-type')) {
            ctx.outgoingHeaders.set('Content-Type', 'text/plain; charset=utf-8');
          }
          await recordSyntheticTest(route, handlerArgs, rawResult, ctx.statusCode);
          return new Response(rawResult, { status: ctx.statusCode, headers: ctx.outgoingHeaders });
        }

        if (rawResult instanceof ReadableStream || rawResult instanceof Uint8Array) {
          return new Response(rawResult, { status: ctx.statusCode, headers: ctx.outgoingHeaders });
        }

        let cleanOutput = applyRedaction(rawResult, config.redact);
        if (method === 'GET' && url.searchParams.has('fields')) {
          cleanOutput = applyFieldMask(cleanOutput, url.searchParams.get('fields'));
        }

        if (cacheKey && !ctx.isSimulated) {
          const ttlMs = parseDuration(route.meta.cache, 60_000);
          route.nodeCache.set(cacheKey, {
            value: cleanOutput,
            expiresAt: Date.now() + ttlMs
          });
        }

        await recordSyntheticTest(route, handlerArgs, cleanOutput, ctx.statusCode);
        return Response.json(cleanOutput, {
          status: ctx.statusCode,
          headers: ctx.outgoingHeaders
        });
      } catch (err) {
        if (err instanceof ServinRedirect) {
          if (ctx.isSimulated) {
            await runUndoStack(ctx);
          } else {
            await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
          }
          ctx.outgoingHeaders.set('Location', err.location);
          return new Response(null, {
            status: err.status,
            headers: ctx.outgoingHeaders
          });
        }

        await runUndoStack(ctx);
        if (!ctx.isSimulated) {
          await ctx.sessionHandle?.commit(ctx.outgoingHeaders).catch(() => { });
        }

        if (err instanceof ServinAbortError) {
          return buildErrorResponse({
            webReq,
            status: err.status,
            defaultPayload: { error: err.message },
            existingCtx: ctx,
            rawError: err
          });
        }

        flushDebugLogs(ctx, err);
        await writeSnapshot(ctx, route, err);

        if (config.onError) {
          const custom = await config.onError(err, { req: webReq });
          if (custom instanceof Response) return custom;
          return Response.json(custom, { status: 500, headers: ctx.outgoingHeaders });
        }

        return buildErrorResponse({
          webReq,
          status: 500,
          defaultPayload: { error: 'Internal Server Error' },
          existingCtx: ctx,
          rawError: err
        });
      } finally {
        if (activeLimiterBucket) {
          const cost = ctx.costExplicit ? ctx.costPoints : 1;
          activeLimiterBucket.remaining = Math.max(
            0,
            Math.min(limiterMax, activeLimiterBucket.remaining - cost)
          );
        }
      }
    });
  }

  async function handleHttp(webReq, socketIp = null) {
    const t0 = performance.now();
    const url = new URL(webReq.url);
    const reqMeta = { cached: false, simulated: false, requestId: null };
    const res = await executeHttp(webReq, reqMeta);

    emitAccessLog({
      method: webReq.method.toUpperCase(),
      url,
      status: res.status,
      durationMs: performance.now() - t0,
      cached: reqMeta.cached,
      simulated: reqMeta.simulated,
      requestId: reqMeta.requestId,
      ip: webReq.headers.get('x-forwarded-for') || socketIp || 'unknown',
      userAgent: webReq.headers.get('user-agent') || ''
    });

    return res;
  }

  const httpServer = http.createServer(async (nodeReq, nodeRes) => {
    const abortCtrl = new AbortController();
    nodeReq.on('close', () => {
      if (!nodeReq.complete) abortCtrl.abort();
    });

    try {
      const webReq = toWebRequest(nodeReq, host, port, abortCtrl.signal);
      const webRes = await handleHttp(webReq, nodeReq.socket?.remoteAddress || null);

      nodeRes.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => {
        nodeRes.appendHeader(key, val);
      });

      if (!webRes.body) {
        nodeRes.end();
        return;
      }

      const reader = webRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
      nodeRes.end();
    } catch {
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = 400;
        nodeRes.end('Bad Request');
      }
    }
  });

  httpServer.on('upgrade', async (nodeReq, tcpSocket, head) => {
    const t0 = performance.now();
    const proto = nodeReq.socket?.encrypted ? 'https' : 'http';
    const reqHost = nodeReq.headers.host || `${host}:${port}`;
    const url = new URL(nodeReq.url || '/', `${proto}://${reqHost}`);
    const clientIp = nodeReq.headers['x-forwarded-for'] || tcpSocket.remoteAddress || 'unknown';
    const userAgent = nodeReq.headers['user-agent'] || '';

    const match = matchDomainRoute(routes, 'WS', url.pathname);
    if (match.status !== 200) {
      tcpSocket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      tcpSocket.destroy();
      emitAccessLog({
        method: 'WS',
        url,
        status: 404,
        durationMs: performance.now() - t0,
        cached: false,
        simulated: false,
        requestId: null,
        ip: clientIp,
        userAgent
      });
      return;
    }

    const webHeaders = new Headers();
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (typeof v === 'string') webHeaders.set(k, v);
    }
    const syntheticReq = new Request(url, { method: 'GET', headers: webHeaders });

    const ctx = createRequestContext({
      req: syntheticReq,
      method: 'WS',
      url,
      sessionManager,
      broker,
      deferTracker
    });

    await wireStorage.run(ctx, async () => {
      try {
        if (ctx.sessionHandle && !(sessionManager.store instanceof MemorySessionStore)) {
          await ctx.sessionHandle.preload();
        }

        for (const guardFn of match.route.guards) {
          await guardFn();
        }

        await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
        ctx.headersSent = true;

        const upgraded = performWsHandshake(nodeReq, tcpSocket, ctx.outgoingHeaders);
        if (!upgraded) {
          tcpSocket.destroy();
          return;
        }

        emitAccessLog({
          method: 'WS',
          url,
          status: 101,
          durationMs: performance.now() - t0,
          cached: false,
          simulated: false,
          requestId: ctx.requestId,
          ip: clientIp,
          userAgent
        });

        const sid = ctx.sessionHandle?.sid || null;
        const linearSocket = createLinearSocket(
          tcpSocket,
          head,
          broker,
          match.route.meta.wsConfig,
          sid
        );

        const paramValues = match.route.paramNames.map((n) => match.params[n]);
        await match.route.handler(...paramValues, linearSocket);
        linearSocket.close(1000, 'Session completed');
      } catch (err) {
        if (err instanceof ServinAbortError) {
          tcpSocket.write(`HTTP/1.1 ${err.status} ${err.message}\r\nConnection: close\r\n\r\n`);
          tcpSocket.destroy();
          emitAccessLog({
            method: 'WS',
            url,
            status: err.status,
            durationMs: performance.now() - t0,
            cached: false,
            simulated: false,
            requestId: ctx.requestId,
            ip: clientIp,
            userAgent
          });
          return;
        }
        flushDebugLogs(ctx, err);
        tcpSocket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        tcpSocket.destroy();
        emitAccessLog({
          method: 'WS',
          url,
          status: 500,
          durationMs: performance.now() - t0,
          cached: false,
          simulated: false,
          requestId: ctx.requestId,
          ip: clientIp,
          userAgent
        });
      } finally {
        await runUndoStack(ctx);
      }
    });
  });

  const shutdown = async () => {
    lagMonitor.stop();
    await new Promise((resolve) => httpServer.close(resolve));
    if (activeDefers.size > 0) {
      await Promise.allSettled([...activeDefers]);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return new Promise((resolve) => {
    httpServer.listen(port, host, async () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const serverUrl = `http://${host}:${actualPort}`;
      const listenInfo = { port: actualPort, host, url: serverUrl };

      if (!silent && config.message !== false) {
        const startupText = typeof config.message === 'function'
          ? config.message(listenInfo)
          : (config.message ?? `[servin] listening on ${serverUrl}`);

        if (startupText) {
          console.log(startupText);
        }
      }

      if (typeof config.onListen === 'function') {
        await config.onListen(listenInfo);
      }

      resolve({
        server: httpServer,
        port: actualPort,
        url: serverUrl,
        fetch: handleHttp,
        close: shutdown
      });
    });
  });
}