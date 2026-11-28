import http from 'node:http';
import fs from 'node:fs';
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
  createDeclarativeWsRuntime,
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

const SERVIN_WELCOME_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101411">
  <meta name="description" content="Servin is a modern, zero-dependency Node.js web server built around Domain-Tree Projection and Ambient Wire.">
  <title>Welcome to Servin</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #101411;
      color: #edf3ed;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    * { box-sizing: border-box; }

    body {
      min-width: 280px;
      min-height: 100vh;
      min-height: 100svh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 32px 24px;
      background:
        radial-gradient(ellipse at 50% 38%, rgba(163, 211, 93, .11), transparent 31rem),
        #101411;
    }

    main { width: min(100%, 680px); text-align: center; }

    .brand-mark {
      width: 48px;
      height: 48px;
      margin: 0 auto 30px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      background: #c5f36b;
      color: #18210c;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 25px;
      font-weight: 800;
      letter-spacing: -.08em;
    }

    .eyebrow {
      margin: 0 0 12px;
      color: #a9c77e;
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .19em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: clamp(2.5rem, 8vw, 4.5rem);
      font-weight: 750;
      letter-spacing: -.065em;
      line-height: 1.05;
    }

    h1 span { color: #c5f36b; }

    .description {
      max-width: 540px;
      margin: 24px auto 0;
      color: #a0aca2;
      font-size: clamp(.98rem, 2.5vw, 1.1rem);
      line-height: 1.8;
    }

    .description strong { color: #dbe7d8; font-weight: 600; }

    @media (max-width: 480px) {
      .brand-mark { margin-bottom: 24px; }
      .description { margin-top: 18px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand-mark" aria-hidden="true">s</div>
    <p class="eyebrow">Node.js Web Server</p>
    <h1>Welcome to <span>Servin</span>.</h1>
    <p class="description">
      A modern, zero-dependency Node.js web server built around
      <strong>Domain-Tree Projection</strong> and <strong>Ambient Wire</strong>.
    </p>
  </main>
</body>
</html>`;

function createWelcomeHandler() {
  return () => new HtmlResponse(SERVIN_WELCOME_HTML);
}

function formatRoutePath(segments = []) {
  if (segments.length === 0) return '/';

  const parts = segments.map((segment) => {
    if (segment.type === 'static') return segment.value;
    if (segment.type === 'param') {
      return `$${segment.param}${segment.parse ? ':typed' : ''}`;
    }

    if (segment.directNodeParam) return `$${segment.param}?`;
    if (segment.raw === '$path') return '$path';
    return `*${segment.param}${segment.optionalWild ? '?' : ''}`;
  });

  return `/${parts.join('/')}`;
}

function getRouteKind(route) {
  if (route.isBuiltin) return 'built-in';
  if (route.staticDescriptor) return 'static';
  if (route.redirectDescriptor) return 'redirect';
  if (route.aliasDescriptor) return 'alias';
  if (route.verbs.includes('WS')) return 'websocket';
  if (route.isAsyncGen) return 'SSE';
  return 'handler';
}

function getRouteSource(route) {
  if (route.isBuiltin) return 'servin welcome fallback';
  if (!route.dotPath) return 'api.<root>';
  if (route.dotPath === 'static' || route.dotPath.startsWith('static.')) return route.dotPath;
  if (route.dotPath === 'alias' || route.dotPath.startsWith('alias.')) return route.dotPath;
  return `api.${route.dotPath}`;
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function getStaticTemplateBoundary(targetTemplate) {
  const absoluteTemplate = path.resolve(String(targetTemplate));
  const parts = absoluteTemplate.split(path.sep);
  const dynamicIndex = parts.findIndex((part) => /\$[a-zA-Z_][a-zA-Z0-9_]*/.test(part));
  if (dynamicIndex === -1) return absoluteTemplate;
  const boundary = parts.slice(0, dynamicIndex).join(path.sep) || path.parse(absoluteTemplate).root;
  return path.resolve(boundary);
}

function interpolateStaticTemplate(template, params = {}) {
  let result = String(template);
  const names = [...result.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((match) => match[1]);
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return null;
    const value = String(params[name]);
    // Template values represent one URL segment, never a path fragment.
    if (
      !value || value === '.' || value === '..' ||
      value.includes('/') || value.includes('\\') || value.includes('\0') ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) return null;
    result = result.replace(new RegExp(`\\$${name}(?![a-zA-Z0-9_])`, 'g'), () => value);
  }
  return path.resolve(result);
}

function normalizeStaticRelativePath(value) {
  return String(value || '').split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
}

function staticBlockGlobToRegExp(pattern) {
  let source = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        // `**/` also matches zero directories, so `**/*.html` matches
        // both `index.html` and `nested/index.html`.
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`${source}$`);
}

function isStaticPathBlocked(relativePath, blocked = []) {
  const normalized = normalizeStaticRelativePath(relativePath);
  const basename = path.posix.basename(normalized);

  return blocked.some((entry) => {
    // A pattern without `/` is matched against the basename at any depth.
    // A pattern with `/` is matched against the full path relative to the mount.
    const candidate = entry.includes('/') ? normalized : basename;
    return staticBlockGlobToRegExp(entry).test(candidate);
  });
}

async function resolveStaticFolderFile(folderConfig, params = {}, subpath = '') {
  const template = folderConfig?.path;
  if (typeof template !== 'string') return { status: 404 };

  const boundaryPath = getStaticTemplateBoundary(template);
  let resolvedRoot = interpolateStaticTemplate(template, params);
  if (!resolvedRoot) return { status: 404 };
  for (const name of folderConfig.folderParams || []) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return { status: 404 };
    const value = String(params[name]);
    if (
      !value || value === '.' || value === '..' ||
      value.includes('/') || value.includes('\\') || value.includes('\0') ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) return { status: 404 };
    resolvedRoot = path.resolve(resolvedRoot, value);
  }
  if (!isPathInside(boundaryPath, resolvedRoot)) return { status: 404 };

  let realBoundary;
  let realRoot;
  try {
    [realBoundary, realRoot] = await Promise.all([
      fsp.realpath(boundaryPath),
      fsp.realpath(resolvedRoot)
    ]);
  } catch {
    return { status: 404 };
  }
  if (!isPathInside(realBoundary, realRoot)) return { status: 404 };

  const rawSubpath = String(subpath || '');
  if (
    rawSubpath.startsWith('/') || rawSubpath.includes('\\') || rawSubpath.includes('\0') ||
    /[\u0000-\u001f\u007f]/.test(rawSubpath)
  ) return { status: 404 };

  const relativeSegments = rawSubpath ? rawSubpath.split('/') : [];
  if (relativeSegments.some((part) => part === '.' || part === '..')) return { status: 404 };
  const candidate = path.resolve(realRoot, ...relativeSegments.filter(Boolean));
  if (!isPathInside(realRoot, candidate)) return { status: 404 };

  let realTarget;
  let stats;
  try {
    realTarget = await fsp.realpath(candidate);
    if (!isPathInside(realRoot, realTarget)) return { status: 404 };
    stats = await fsp.stat(realTarget);
  } catch {
    return { status: 404 };
  }

  if (stats.isDirectory()) {
    const indexName = folderConfig.options?.index === undefined
      ? 'index.html'
      : folderConfig.options.index;
    if (indexName === false || typeof indexName !== 'string' || !indexName.trim()) return { status: 404 };
    const indexParts = indexName.replace(/\\/g, '/').split('/');
    if (indexParts.some((part) => !part || part === '.' || part === '..')) return { status: 404 };
    const indexCandidate = path.resolve(realTarget, ...indexParts);
    if (!isPathInside(realRoot, indexCandidate)) return { status: 404 };
    try {
      realTarget = await fsp.realpath(indexCandidate);
      if (!isPathInside(realRoot, realTarget)) return { status: 404 };
      stats = await fsp.stat(realTarget);
    } catch {
      return { status: 404 };
    }
  }

  if (!stats.isFile()) return { status: 404 };

  const relativePath = normalizeStaticRelativePath(path.relative(realRoot, realTarget));
  const blocked = folderConfig.block || [];
  if (isStaticPathBlocked(relativePath, blocked)) return { status: 404 };

  const dotfiles = folderConfig.options?.dotfiles || 'ignore';
  const hasDotfile = relativePath.split('/').some((part) => part.startsWith('.'));
  if (hasDotfile && dotfiles !== 'allow') {
    return { status: dotfiles === 'deny' ? 403 : 404 };
  }

  return { status: 200, filePath: realTarget, relativePath };
}

function formatRouteTable(routes, { liveReloadEnabled = false } = {}) {
  const entries = routes.map((route) => ({
    method: route.verbs.join('|'),
    path: formatRoutePath(route.segments),
    type: getRouteKind(route),
    source: getRouteSource(route)
  }));

  // These endpoints are dispatched directly by the server, outside the
  // compiled domain tree, but are still part of the effective routing map.
  entries.push({
    method: 'GET',
    path: '/@client.js',
    type: 'virtual',
    source: 'servin client module'
  });

  if (liveReloadEnabled) {
    entries.push(
      {
        method: 'GET',
        path: '/@servin/reload-client.js',
        type: 'internal',
        source: 'servin live reload client'
      },
      {
        method: 'GET',
        path: '/@servin/reload',
        type: 'SSE',
        source: 'servin live reload events'
      }
    );
  }

  const methodWidth = Math.max('METHOD'.length, ...entries.map((entry) => entry.method.length));
  const pathWidth = Math.max('PATH'.length, ...entries.map((entry) => entry.path.length));
  const typeWidth = Math.max('TYPE'.length, ...entries.map((entry) => entry.type.length));
  const sourceWidth = Math.max('SOURCE'.length, ...entries.map((entry) => entry.source.length));
  const header = [
    'METHOD'.padEnd(methodWidth),
    'PATH'.padEnd(pathWidth),
    'TYPE'.padEnd(typeWidth),
    'SOURCE'.padEnd(sourceWidth)
  ].join('  ');
  const separator = [
    '-'.repeat(methodWidth),
    '-'.repeat(pathWidth),
    '-'.repeat(typeWidth),
    '-'.repeat(sourceWidth)
  ].join('  ');
  const rows = entries.map((entry) => [
    entry.method.padEnd(methodWidth),
    entry.path.padEnd(pathWidth),
    entry.type.padEnd(typeWidth),
    entry.source.padEnd(sourceWidth)
  ].join('  '));

  return [
    `[servin] routing table (${entries.length} routes)`,
    header,
    separator,
    ...rows
  ].join('\n');
}

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

async function resolveAliasChain({ initialMatch, initialUrl, routes, method, onGuard }) {
  const visitedAliases = new Set();
  let activeMatch = initialMatch;
  let effectiveUrl = initialUrl;
  let inheritedMeta = {};

  while (activeMatch.status === 200 && activeMatch.route.aliasDescriptor) {
    const aliasRoute = activeMatch.route;
    if (visitedAliases.has(aliasRoute.nodeId) || visitedAliases.size >= 10) {
      throw new ServinAbortError(500, 'Alias routing loop detected');
    }
    visitedAliases.add(aliasRoute.nodeId);

    if (onGuard) {
      await onGuard(aliasRoute.guards);
    }
    inheritedMeta = { ...inheritedMeta, ...aliasRoute.meta };

    const desc = aliasRoute.aliasDescriptor;
    const paramValues = aliasRoute.paramNames.map((name) => activeMatch.params[name]);
    const queryObj = Object.fromEntries(effectiveUrl.searchParams.entries());

    let rawTarget = typeof desc.target === 'function'
      ? await desc.target(...paramValues, queryObj)
      : desc.target;

    if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
      throw new ServinAbortError(500, 'Invalid alias target');
    }

    if (typeof desc.target === 'string') {
      rawTarget = rawTarget.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (full, name) => {
        if (!Object.prototype.hasOwnProperty.call(activeMatch.params, name)) return full;
        const val = String(activeMatch.params[name]);
        return val.split('/').map(encodeURIComponent).join('/');
      });
    }

    const normalizedTarget = rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`;
    const targetUrl = new URL(normalizedTarget, effectiveUrl.origin);

    const mergedParams = new URLSearchParams(targetUrl.searchParams);
    for (const [k, v] of effectiveUrl.searchParams.entries()) {
      mergedParams.set(k, v);
    }
    targetUrl.search = mergedParams.toString();
    effectiveUrl = targetUrl;

    if (method === 'GET' && effectiveUrl.pathname === '/@client.js') {
      return {
        isVirtualClient: true,
        match: activeMatch,
        url: effectiveUrl,
        inheritedMeta
      };
    }

    activeMatch = matchDomainRoute(routes, method, effectiveUrl.pathname);
  }

  return {
    isVirtualClient: false,
    match: activeMatch,
    url: effectiveUrl,
    inheritedMeta
  };
}

export function serve(config = {}) {
  const port = config.port ?? 3000;
  const host = config.host ?? '127.0.0.1';
  const silent = config.silent ?? false;

  const liveReloadOptions = config.liveReload && typeof config.liveReload === 'object'
    ? config.liveReload
    : {};
  const liveReloadRequested = config.liveReload === true || liveReloadOptions.enabled === true;
  const liveReloadEnabled = liveReloadRequested && process.env.NODE_ENV !== 'production';
  const LIVE_RELOAD_EVENTS_PATH = '/@servin/reload';
  const LIVE_RELOAD_SCRIPT_PATH = '/@servin/reload-client.js';
  const liveReloadClients = new Set();
  const liveReloadWatchers = new Map();
  const liveReloadEncoder = new TextEncoder();
  const liveReloadRoot = path.resolve(liveReloadOptions.root || process.cwd());
  const rawLiveReloadTargets = liveReloadOptions.watch ?? ['./views'];
  const liveReloadTargets = (Array.isArray(rawLiveReloadTargets)
    ? rawLiveReloadTargets
    : [rawLiveReloadTargets]
  ).filter((item) => typeof item === 'string' && item.trim().length > 0);
  const liveReloadIgnore = Array.isArray(liveReloadOptions.ignore)
    ? liveReloadOptions.ignore.filter((item) => typeof item === 'string')
    : [];
  const liveReloadDebounceMs = Math.max(50, Number(liveReloadOptions.debounceMs) || 120);
  const liveReloadIgnoredNames = new Set(['node_modules', '.git', '.hg', '.svn']);
  let liveReloadDebounceTimer = null;
  let liveReloadRefreshTimer = null;
  let liveReloadHeartbeatTimer = null;
  let liveReloadRefreshPromise = null;
  let liveReloadStopped = false;

  const liveReloadClientCode = `(() => {
  if (window.__SERVIN_LIVE_RELOAD__) return;
  window.__SERVIN_LIVE_RELOAD__ = true;

  const events = new EventSource('${LIVE_RELOAD_EVENTS_PATH}');
  events.addEventListener('reload', () => window.location.reload());

  window.addEventListener('pagehide', () => events.close(), { once: true });
})();`;

  function liveReloadLog(message, error = null) {
    if (silent) return;
    if (error) console.warn(`[servin] live reload: ${message}`, error);
    else console.log(`[servin] live reload: ${message}`);
  }

  function isLiveReloadIgnored(absolutePath) {
    const relativePath = path.relative(liveReloadRoot, absolutePath);
    const segments = relativePath.split(path.sep).filter(Boolean);
    if (segments.some((segment) => liveReloadIgnoredNames.has(segment))) return true;

    const normalized = relativePath.split(path.sep).join('/');
    return liveReloadIgnore.some((ignored) => {
      const clean = ignored.replace(/^\.\//, '').replace(/\/$/, '');
      return normalized === clean || normalized.startsWith(`${clean}/`);
    });
  }

  function stopLiveReloadHeartbeat() {
    if (!liveReloadHeartbeatTimer) return;
    clearInterval(liveReloadHeartbeatTimer);
    liveReloadHeartbeatTimer = null;
  }

  function closeLiveReloadClient(client) {
    if (!liveReloadClients.delete(client)) return;
    client.signal?.removeEventListener('abort', client.onAbort);
    if (liveReloadClients.size === 0) stopLiveReloadHeartbeat();
    try {
      client.controller.close();
    } catch {
      // The client may already have disconnected or canceled its stream.
    }
  }

  function ensureLiveReloadHeartbeat() {
    if (liveReloadHeartbeatTimer || liveReloadClients.size === 0) return;
    liveReloadHeartbeatTimer = setInterval(() => {
      const frame = liveReloadEncoder.encode(': keep-alive\n\n');
      for (const client of [...liveReloadClients]) {
        try {
          client.controller.enqueue(frame);
        } catch {
          closeLiveReloadClient(client);
        }
      }
    }, 15_000);
    liveReloadHeartbeatTimer.unref?.();
  }

  function createLiveReloadEventsResponse(signal) {
    let client = null;
    const stream = new ReadableStream({
      start(controller) {
        client = {
          controller,
          signal,
          onAbort: null
        };
        client.onAbort = () => closeLiveReloadClient(client);

        liveReloadClients.add(client);
        controller.enqueue(liveReloadEncoder.encode(': connected\n\n'));
        signal.addEventListener('abort', client.onAbort, { once: true });
        ensureLiveReloadHeartbeat();
        if (signal.aborted) closeLiveReloadClient(client);
      },
      cancel() {
        if (client) closeLiveReloadClient(client);
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  function broadcastLiveReload() {
    if (liveReloadStopped || liveReloadClients.size === 0) return;
    const frame = liveReloadEncoder.encode(
      `event: reload\ndata: ${JSON.stringify({ changedAt: Date.now() })}\n\n`
    );

    for (const client of [...liveReloadClients]) {
      try {
        client.controller.enqueue(frame);
      } catch {
        closeLiveReloadClient(client);
      }
    }
  }

  function queueLiveReload() {
    if (liveReloadStopped) return;
    if (liveReloadDebounceTimer) clearTimeout(liveReloadDebounceTimer);
    liveReloadDebounceTimer = setTimeout(() => {
      liveReloadDebounceTimer = null;
      broadcastLiveReload();
    }, liveReloadDebounceMs);
    liveReloadDebounceTimer.unref?.();
  }

  function queueLiveReloadRefresh() {
    if (liveReloadStopped || liveReloadRefreshTimer) return;
    liveReloadRefreshTimer = setTimeout(() => {
      liveReloadRefreshTimer = null;
      refreshLiveReloadWatchers().catch((err) => liveReloadLog('failed to refresh watchers', err));
    }, 80);
    liveReloadRefreshTimer.unref?.();
  }

  async function collectLiveReloadDirectories() {
    const desired = new Map();

    function addDirectory(directory, { all = false, filename = null, refreshOnRename = false } = {}) {
      let entry = desired.get(directory);
      if (!entry) {
        entry = { all: false, names: new Set(), refreshOnRename: false };
        desired.set(directory, entry);
      }
      if (all) entry.all = true;
      if (filename) entry.names.add(filename);
      if (refreshOnRename) entry.refreshOnRename = true;
    }

    async function scanDirectory(directory) {
      if (isLiveReloadIgnored(directory)) return;
      addDirectory(directory, { all: true, refreshOnRename: true });

      let entries;
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch (err) {
        liveReloadLog(`cannot read ${directory}`, err);
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const childPath = path.join(directory, entry.name);
        if (!isLiveReloadIgnored(childPath)) await scanDirectory(childPath);
      }
    }

    for (const target of liveReloadTargets) {
      const absoluteTarget = path.resolve(liveReloadRoot, target);
      if (isLiveReloadIgnored(absoluteTarget)) continue;

      let stats;
      try {
        stats = await fsp.stat(absoluteTarget);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          const parent = path.dirname(absoluteTarget);
          try {
            const parentStats = await fsp.stat(parent);
            if (parentStats.isDirectory()) {
              addDirectory(parent, {
                filename: path.basename(absoluteTarget),
                refreshOnRename: true
              });
              liveReloadLog(`waiting for ${absoluteTarget} to be created`);
              continue;
            }
          } catch {
            // Fall through to the warning below.
          }
        }
        liveReloadLog(`cannot watch ${absoluteTarget}`, err);
        continue;
      }

      if (stats.isDirectory()) {
        await scanDirectory(absoluteTarget);
      } else if (stats.isFile()) {
        addDirectory(path.dirname(absoluteTarget), {
          filename: path.basename(absoluteTarget)
        });
      }
    }

    return desired;
  }

  async function refreshLiveReloadWatchers() {
    if (!liveReloadEnabled || liveReloadStopped) return;
    if (liveReloadRefreshPromise) return liveReloadRefreshPromise;

    liveReloadRefreshPromise = (async () => {
      const desired = await collectLiveReloadDirectories();

      for (const [directory, current] of liveReloadWatchers) {
        if (desired.has(directory)) continue;
        current.watcher.close();
        liveReloadWatchers.delete(directory);
      }

      for (const [directory, spec] of desired) {
        const current = liveReloadWatchers.get(directory);
        if (current) {
          current.all = spec.all;
          current.names = spec.names;
          current.refreshOnRename = spec.refreshOnRename;
          continue;
        }

        try {
          const watcher = fs.watch(directory, { persistent: false, encoding: 'utf8' }, (eventType, filename) => {
            const entry = liveReloadWatchers.get(directory);
            if (!entry || liveReloadStopped) return;

            const name = filename == null ? null : path.basename(String(filename));
            const relevant = name === null
              ? (entry.all || entry.names.size > 0)
              : (entry.all || entry.names.has(name));
            if (!relevant) return;

            queueLiveReload();
            if (eventType === 'rename' && entry.refreshOnRename) {
              queueLiveReloadRefresh();
            }
          });

          watcher.on('error', (err) => {
            liveReloadLog(`watcher error for ${directory}`, err);
            watcher.close();
            liveReloadWatchers.delete(directory);
          });

          liveReloadWatchers.set(directory, {
            watcher,
            all: spec.all,
            names: spec.names,
            refreshOnRename: spec.refreshOnRename
          });
        } catch (err) {
          liveReloadLog(`cannot watch ${directory}`, err);
        }
      }
    })();

    try {
      await liveReloadRefreshPromise;
    } finally {
      liveReloadRefreshPromise = null;
    }
  }

  async function startLiveReload() {
    if (!liveReloadEnabled) return;
    await refreshLiveReloadWatchers();
    liveReloadLog(`enabled; watching ${liveReloadTargets.length} target(s)`);
  }

  function stopLiveReload() {
    liveReloadStopped = true;
    if (liveReloadDebounceTimer) clearTimeout(liveReloadDebounceTimer);
    if (liveReloadRefreshTimer) clearTimeout(liveReloadRefreshTimer);
    liveReloadDebounceTimer = null;
    liveReloadRefreshTimer = null;
    stopLiveReloadHeartbeat();

    for (const client of [...liveReloadClients]) closeLiveReloadClient(client);
    for (const { watcher } of liveReloadWatchers.values()) watcher.close();
    liveReloadWatchers.clear();
  }

  async function injectLiveReloadClient(webReq, response) {
    if (!liveReloadEnabled || webReq.method.toUpperCase() !== 'GET' || response.status !== 200) {
      return response;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/^text\/html(?:\s*;|$)/i.test(contentType)) return response;
    if (response.headers.has('content-encoding') || !response.body) return response;
    if ((response.headers.get('content-disposition') || '').toLowerCase().startsWith('attachment')) {
      return response;
    }

    let html;
    try {
      html = await response.text();
    } catch {
      return response;
    }

    const marker = 'data-servin-live-reload';
    let output = html;
    let injected = false;

    if (!output.includes(marker)) {
      const scriptTag = `<script src="${LIVE_RELOAD_SCRIPT_PATH}" ${marker} defer></script>`;
      if (/<\/body\s*>/i.test(output)) {
        output = output.replace(/<\/body\s*>/i, `${scriptTag}\n</body>`);
      } else {
        output += `\n${scriptTag}`;
      }
      injected = true;
    }

    const headers = new Headers(response.headers);
    if (injected) {
      headers.delete('content-length');
      headers.delete('content-encoding');
      headers.delete('content-md5');
      headers.delete('etag');
      headers.delete('content-range');
      headers.delete('accept-ranges');
      headers.set('Cache-Control', 'no-store');
    }

    return new Response(output, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  if (liveReloadRequested && !liveReloadEnabled && !silent) {
    console.warn('[servin] live reload is disabled when NODE_ENV=production');
  }

  const routes = compileDomainTree(
    config.api || {},
    config.types || {},
    config.static || null,
    config.alias ?? config.aliases ?? null,
    createWelcomeHandler()
  );
  const virtualClientCode = generateVirtualClientModule(routes);

  const broker = new WebSocketBroker();
  const declarativeRuntimes = new Map();
  const sessionManager = config.session ? new SessionManager(config.session, broker) : null;
  const lagMonitor = createLagMonitor(config.lagThresholdMs ?? 60);
  const rateBuckets = new Map();
  const activeDefers = new Set();
  const recordedTests = new Map();

  function getDeclarativeRuntime(route) {
    const cfg = route.meta?.wsConfig;
    if (!cfg || typeof cfg !== 'object' || (!cfg.open && !cfg.actions && !cfg.close && !cfg.state)) {
      return null;
    }
    if (!declarativeRuntimes.has(route.nodeId)) {
      declarativeRuntimes.set(route.nodeId, createDeclarativeWsRuntime(broker, cfg));
    }
    return declarativeRuntimes.get(route.nodeId);
  }

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

    if (liveReloadEnabled && method === 'GET') {
      if (url.pathname === LIVE_RELOAD_SCRIPT_PATH) {
        return new Response(liveReloadClientCode, {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      }

      if (url.pathname === LIVE_RELOAD_EVENTS_PATH) {
        return createLiveReloadEventsResponse(webReq.signal);
      }
    }

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

    const { route: initialRoute, params: initialParams } = match;

    if (initialRoute.meta.priority === 'low' && lagMonitor.isOverloaded()) {
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
      params: initialParams,
      signal: webReq.signal,
      sessionManager,
      broker,
      deferTracker
    });

    reqMeta.requestId = ctx.requestId;
    reqMeta.simulated = ctx.isSimulated;

    applyCorsHeaders(webReq, ctx.outgoingHeaders);

    return wireStorage.run(ctx, async () => {
      let activeLimiterBucket = null;
      let limiterMax = 0;
      let route = initialRoute;

      try {
        if (ctx.sessionHandle && !(sessionManager.store instanceof MemorySessionStore)) {
          await ctx.sessionHandle.preload();
        }

        const resolved = await resolveAliasChain({
          initialMatch: match,
          initialUrl: url,
          routes,
          method,
          onGuard: async (guards) => {
            for (const guardFn of guards) {
              await guardFn();
            }
          }
        });

        if (resolved.isVirtualClient) {
          if (!ctx.isSimulated) {
            await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
          }
          ctx.outgoingHeaders.set('Content-Type', 'application/javascript; charset=utf-8');
          ctx.outgoingHeaders.set('Cache-Control', 'no-cache');
          return new Response(virtualClientCode, { status: 200, headers: ctx.outgoingHeaders });
        }

        const activeMatch = resolved.match;
        const effectiveUrl = resolved.url;

        if (method === 'OPTIONS' && activeMatch.status === 405) {
          const headers = new Headers({
            Allow: activeMatch.allow,
            'Access-Control-Allow-Methods': `${activeMatch.allow}, OPTIONS`,
            'Access-Control-Allow-Headers': webReq.headers.get('access-control-request-headers') || 'Content-Type, Authorization, Idempotency-Key, X-Simulate'
          });
          applyCorsHeaders(webReq, headers);
          return new Response(null, { status: 204, headers });
        }

        if (activeMatch.status === 404) {
          return buildErrorResponse({
            webReq,
            status: 404,
            defaultPayload: { error: 'Not Found' },
            existingCtx: ctx
          });
        }
        if (activeMatch.status === 405) {
          return buildErrorResponse({
            webReq,
            status: 405,
            defaultPayload: null,
            existingCtx: ctx,
            extraHeaders: { Allow: activeMatch.allow }
          });
        }

        route = activeMatch.route;
        const params = activeMatch.params;
        ctx.url = effectiveUrl;
        ctx.params = params;

        const effectiveMeta = { ...resolved.inheritedMeta, ...route.meta };
        if (effectiveMeta.priority === 'low' && lagMonitor.isOverloaded()) {
          return buildErrorResponse({
            webReq,
            status: 503,
            defaultPayload: { error: 'Service temporarily overloaded' },
            existingCtx: ctx,
            extraHeaders: { 'Retry-After': '2' }
          });
        }

        if (effectiveMeta.sunset) {
          ctx.outgoingHeaders.set('Deprecation', 'true');
          ctx.outgoingHeaders.set('Sunset', new Date(effectiveMeta.sunset).toUTCString());
        }

        for (const guardFn of route.guards) {
          await guardFn();
        }

        if (route.redirectDescriptor) {
          const paramValues = route.paramNames.map((name) => params[name]);
          const queryObj = Object.fromEntries(effectiveUrl.searchParams.entries());
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

        if (route.staticDescriptor) {
          if (route.staticFolderConfig) {
            const resolved = await resolveStaticFolderFile(
              route.staticFolderConfig,
              params,
              params.subpath || ''
            );

            if (resolved.status !== 200) {
              return buildErrorResponse({
                webReq,
                status: resolved.status,
                defaultPayload: { error: resolved.status === 403 ? 'Forbidden' : 'File Not Found' },
                existingCtx: ctx
              });
            }

            const fileRes = await buildFileHttpResponse(
              wire.file(resolved.filePath),
              webReq.headers,
              { method, returnMissing: true }
            );
            if (!fileRes) {
              return buildErrorResponse({
                webReq,
                status: 404,
                defaultPayload: { error: 'File Not Found' },
                existingCtx: ctx
              });
            }

            const cacheControl = route.staticFolderConfig.options?.cacheControl;
            if (cacheControl && !fileRes.headers.has('Cache-Control')) {
              fileRes.headers.set('Cache-Control', String(cacheControl));
            }
            if (!ctx.isSimulated) {
              await ctx.sessionHandle?.commit(ctx.outgoingHeaders);
            }
            ctx.outgoingHeaders.forEach((v, k) => {
              if (!fileRes.headers.has(k)) fileRes.headers.set(k, v);
            });
            return fileRes;
          }

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
        const queryObj = Object.fromEntries(effectiveUrl.searchParams.entries());
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

        const cacheKey = route.nodeCache && method === 'GET'
          ? `${route.nodeId}:${JSON.stringify(params)}:${effectiveUrl.search}`
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
          const coalKey = `${route.nodeId}:${JSON.stringify(params)}:${effectiveUrl.search}`;
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
        if (method === 'GET' && effectiveUrl.searchParams.has('fields')) {
          cleanOutput = applyFieldMask(cleanOutput, effectiveUrl.searchParams.get('fields'));
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
    const rawResponse = await executeHttp(webReq, reqMeta);
    const res = await injectLiveReloadClient(webReq, rawResponse);

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
    nodeRes.on('close', () => {
      if (!nodeRes.writableEnded) abortCtrl.abort();
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
      params: match.params,
      sessionManager,
      broker,
      deferTracker
    });

    await wireStorage.run(ctx, async () => {
      try {
        if (ctx.sessionHandle && !(sessionManager.store instanceof MemorySessionStore)) {
          await ctx.sessionHandle.preload();
        }

        const resolved = await resolveAliasChain({
          initialMatch: match,
          initialUrl: url,
          routes,
          method: 'WS',
          onGuard: async (guards) => {
            for (const guardFn of guards) {
              await guardFn();
            }
          }
        });

        if (resolved.match.status !== 200) {
          tcpSocket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          tcpSocket.destroy();
          emitAccessLog({
            method: 'WS',
            url,
            status: 404,
            durationMs: performance.now() - t0,
            cached: false,
            simulated: false,
            requestId: ctx.requestId,
            ip: clientIp,
            userAgent
          });
          return;
        }

        const activeMatch = resolved.match;
        const effectiveUrl = resolved.url;
        ctx.url = effectiveUrl;
        ctx.params = activeMatch.params;

        for (const guardFn of activeMatch.route.guards) {
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
        const wsCfg = activeMatch.route.meta.wsConfig || {};
        const linearSocket = createLinearSocket(
          tcpSocket,
          head,
          broker,
          wsCfg,
          sid
        );

        const connData = {};
        for (const [k, v] of effectiveUrl.searchParams.entries()) {
          if (k !== '__lastSeq') connData[k] = v;
        }
        const lastSeq = Number(effectiveUrl.searchParams.get('__lastSeq') || 0);
        const reqInfo = {
          raw: nodeReq,
          url: effectiveUrl,
          data: connData,
          query: effectiveUrl.searchParams,
          params: activeMatch.params,
          lastSeq
        };

        const declarativeRunner = getDeclarativeRuntime(activeMatch.route);
        if (declarativeRunner) {
          await declarativeRunner(linearSocket, reqInfo);
        } else {
          const paramValues = activeMatch.route.paramNames.map((n) => activeMatch.params[n]);
          await activeMatch.route.handler(...paramValues, linearSocket);
        }
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
    stopLiveReload();
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
      await startLiveReload();
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

      if (!silent && config.showRoutes === true) {
        console.log(formatRouteTable(routes, { liveReloadEnabled }));
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
