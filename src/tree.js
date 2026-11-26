import { StaticRouteDescriptor, RedirectDescriptor, AliasDescriptor } from './utils.js';

const GUARD_META = Symbol('servin.guard');
const PARAM_META = Symbol('servin.param');

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ALL_ALIAS_VERBS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'WS'];
const META_KEYS = new Set([
  'expect',
  'cache',
  'coalesce',
  'idempotent',
  'limit',
  'webhook',
  'wsConfig',
  'priority',
  'sunset',
  'rawBody'
]);

const AsyncGeneratorFunction = (async function* () { }).constructor;

const BUILTIN_PARAM_TYPES = {
  int(raw) {
    if (!/^\d+$/.test(raw)) return { ok: false };
    const val = Number(raw);
    if (!Number.isSafeInteger(val)) return { ok: false };
    return { ok: true, value: val };
  },
  number(raw) {
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return { ok: false };
    const val = Number(raw);
    if (!Number.isFinite(val)) return { ok: false };
    return { ok: true, value: val };
  },
  float(raw) {
    return BUILTIN_PARAM_TYPES.number(raw);
  },
  bigint(raw) {
    if (!/^-?\d+$/.test(raw)) return { ok: false };
    try {
      return { ok: true, value: BigInt(raw) };
    } catch {
      return { ok: false };
    }
  },
  uuid(raw) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      return { ok: false };
    }
    return { ok: true, value: raw.toLowerCase() };
  },
  alpha(raw) {
    if (!/^[a-zA-Z]+$/.test(raw)) return { ok: false };
    return { ok: true, value: raw };
  },
  alnum(raw) {
    if (!/^[a-zA-Z0-9]+$/.test(raw)) return { ok: false };
    return { ok: true, value: raw };
  },
  slug(raw) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return { ok: false };
    return { ok: true, value: raw };
  },
  bool(raw) {
    const lower = raw.toLowerCase();
    if (lower === 'true' || lower === '1') return { ok: true, value: true };
    if (lower === 'false' || lower === '0') return { ok: true, value: false };
    return { ok: false };
  },
  boolean(raw) {
    return BUILTIN_PARAM_TYPES.bool(raw);
  },
  string(raw) {
    return { ok: true, value: raw };
  }
};

function resolveParamParser(rule, customTypes = {}, rawSegment = '') {
  if (rule === Number) return BUILTIN_PARAM_TYPES.number;
  if (rule === Boolean) return BUILTIN_PARAM_TYPES.bool;
  if (rule === BigInt) return BUILTIN_PARAM_TYPES.bigint;
  if (rule === String) return BUILTIN_PARAM_TYPES.string;

  if (rule instanceof RegExp) {
    const rx = new RegExp(rule.source, rule.flags.replace(/[gy]/g, ''));
    return (raw) => (rx.test(raw) ? { ok: true, value: raw } : { ok: false });
  }

  if (typeof rule === 'function') {
    return (raw) => {
      try {
        const parsed = rule(raw);
        if (parsed === undefined || parsed === null || parsed === false) {
          return { ok: false };
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false };
      }
    };
  }

  if (typeof rule === 'string') {
    if (customTypes && Object.prototype.hasOwnProperty.call(customTypes, rule)) {
      return resolveParamParser(customTypes[rule], {}, rawSegment);
    }
    if (Object.prototype.hasOwnProperty.call(BUILTIN_PARAM_TYPES, rule)) {
      return BUILTIN_PARAM_TYPES[rule];
    }
  }

  throw new Error(`[servin] Invalid parameter rule "${String(rule)}" on segment "${rawSegment}"`);
}

function attachMeta(branch, { addGuard, setParam }) {
  const existingGuards = branch?.[GUARD_META] || [];
  const existingParam = branch?.[PARAM_META] || null;
  const nextGuards = addGuard ? [addGuard, ...existingGuards] : existingGuards;
  const nextParam = setParam !== undefined ? setParam : existingParam;

  let target;
  if (typeof branch === 'function') {
    if (branch instanceof AsyncGeneratorFunction) {
      target = async function* (...args) {
        return yield* branch(...args);
      };
    } else {
      target = function (...args) {
        return branch.apply(this, args);
      };
    }
  } else if (
    branch instanceof StaticRouteDescriptor ||
    branch instanceof RedirectDescriptor ||
    branch instanceof AliasDescriptor
  ) {
    target = Object.assign(Object.create(Object.getPrototypeOf(branch)), branch);
  } else if (branch && typeof branch === 'object') {
    target = { ...branch };
  } else {
    throw new TypeError('Branch must be a route object, descriptor, or handler function');
  }

  if (nextGuards.length > 0) {
    Object.defineProperty(target, GUARD_META, {
      value: nextGuards,
      enumerable: false,
      configurable: true
    });
  }
  if (nextParam) {
    Object.defineProperty(target, PARAM_META, {
      value: nextParam,
      enumerable: false,
      configurable: true
    });
  }
  return target;
}

export function guard(policyFn, branch) {
  if (typeof policyFn !== 'function') {
    throw new TypeError('guard(policyFn, branch) requires a policy function');
  }
  return attachMeta(branch, { addGuard: policyFn });
}

export function param(rule, branch) {
  if (rule === undefined || rule === null) {
    throw new TypeError('param(rule, branch) requires a type name, constructor, RegExp, or validator function');
  }
  return attachMeta(branch, { setParam: rule });
}

export function serveStatic(targetPath, options = {}) {
  return new StaticRouteDescriptor(targetPath, options);
}

export function redirect(target, status = 301) {
  return new RedirectDescriptor(target, status);
}

export function alias(target, options = {}) {
  return new AliasDescriptor(target, options);
}

function parseVerbKey(key) {
  if (key === 'ws') return ['WS'];
  const parts = key.split('|').map((s) => s.trim().toUpperCase());
  if (parts.length > 0 && parts.every((p) => HTTP_VERBS.has(p))) {
    return parts;
  }
  return null;
}

function classifySegment(seg, customTypes = {}, paramRule = null) {
  if (seg === '$path') {
    return { type: 'wild', priority: 3, param: 'path', parse: null, raw: seg };
  }
  if (seg.startsWith('$') && seg.length > 1) {
    const paramName = seg.slice(1);
    if (paramRule !== null && paramRule !== undefined) {
      const parse = resolveParamParser(paramRule, customTypes, seg);
      return { type: 'param', priority: 1, param: paramName, parse, raw: seg };
    }
    return { type: 'param', priority: 2, param: paramName, parse: null, raw: seg };
  }
  if (paramRule !== null && paramRule !== undefined) {
    throw new Error(`[servin] param() can only be applied to dynamic "$" segments, got "${seg}"`);
  }
  return { type: 'static', priority: 0, value: seg, parse: null, raw: seg };
}
export function compileDomainTree(apiRoot = {}, customTypes = {}, staticConfig = null, aliasConfig = null) {
  const routes = [];
  let nodeCounter = 0;

  function registerStaticDescriptor(descriptor, baseSegments, dotPath, inheritedGuards, inheritedMeta, isRootFallback = false) {
    const wildSeg = {
      type: 'wild',
      priority: isRootFallback ? 4 : 3,
      param: 'subpath',
      optionalWild: true,
      parse: null,
      raw: '$subpath'
    };
    const fullSegments = [...baseSegments, wildSeg];
    const paramNames = fullSegments.filter((s) => s.type !== 'static').map((s) => s.param);
    const descGuards = [...inheritedGuards, ...(descriptor[GUARD_META] || [])];

    routes.push({
      nodeId: `static_${++nodeCounter}`,
      dotPath: dotPath.join('.'),
      segments: fullSegments,
      paramNames,
      verbs: ['GET', 'HEAD'],
      staticDescriptor: descriptor,
      handler: null,
      isAsyncGen: false,
      guards: descGuards,
      meta: inheritedMeta,
      nodeCache: null,
      ancestorCaches: [],
      nodeInFlight: null,
      nodeIdempotency: null
    });
  }

  function registerRedirectDescriptor(descriptor, fullSegments, dotPath, inheritedGuards, inheritedMeta, verbs = ['GET', 'HEAD']) {
    const paramNames = fullSegments.filter((s) => s.type !== 'static').map((s) => s.param);
    const descGuards = [...inheritedGuards, ...(descriptor[GUARD_META] || [])];

    routes.push({
      nodeId: `redirect_${++nodeCounter}`,
      dotPath: dotPath.join('.'),
      segments: fullSegments,
      paramNames,
      verbs,
      redirectDescriptor: descriptor,
      handler: null,
      isAsyncGen: false,
      guards: descGuards,
      meta: inheritedMeta,
      nodeCache: null,
      ancestorCaches: [],
      nodeInFlight: null,
      nodeIdempotency: null
    });
  }

  function registerAliasDescriptor(descriptor, fullSegments, dotPath, inheritedGuards, inheritedMeta, verbs = ALL_ALIAS_VERBS) {
    const paramNames = fullSegments.filter((s) => s.type !== 'static').map((s) => s.param);
    const descGuards = [...inheritedGuards, ...(descriptor[GUARD_META] || [])];

    routes.push({
      nodeId: `alias_${++nodeCounter}`,
      dotPath: dotPath.join('.'),
      segments: fullSegments,
      paramNames,
      verbs,
      aliasDescriptor: descriptor,
      handler: null,
      isAsyncGen: false,
      guards: descGuards,
      meta: inheritedMeta,
      nodeCache: null,
      ancestorCaches: [],
      nodeInFlight: null,
      nodeIdempotency: null
    });
  }

  function walk(node, segments, dotPath, inheritedGuards, inheritedMeta, ancestorCaches) {
    if (!node || typeof node !== 'object') return;

    const nodeId = `node_${++nodeCounter}`;
    const guards = [...inheritedGuards, ...(node[GUARD_META] || [])];
    const meta = { ...inheritedMeta };

    for (const mk of META_KEYS) {
      if (mk in node) meta[mk] = node[mk];
    }

    const nodeCache = node.cache ? new Map() : null;
    const nextAncestorCaches = nodeCache ? [...ancestorCaches, nodeCache] : ancestorCaches;
    const nodeInFlight = meta.coalesce ? new Map() : null;
    const nodeIdempotency = meta.idempotent ? new Map() : null;

    const hasExplicitDynamicChild = Object.keys(node).some(
      (k) => !META_KEYS.has(k) && k.startsWith('$')
    );

    for (const [key, value] of Object.entries(node)) {
      if (META_KEYS.has(key)) continue;

      if (key === 'ws' && value && typeof value === 'object') {
        const paramNames = segments.filter((s) => s.type !== 'static').map((s) => s.param);
        const wsMeta = { ...meta, wsConfig: value };
        routes.push({
          nodeId: `${nodeId}_ws`,
          dotPath: [...dotPath, key].join('.'),
          segments,
          paramNames,
          verbs: ['WS'],
          handler: typeof value.handler === 'function' ? value.handler : null,
          isAsyncGen: false,
          guards,
          meta: wsMeta,
          nodeCache: null,
          ancestorCaches,
          nodeInFlight: null,
          nodeIdempotency: null
        });
        continue;
      }

      const verbs = parseVerbKey(key);
      if (verbs && value instanceof RedirectDescriptor) {
        registerRedirectDescriptor(value, segments, [...dotPath, key], guards, meta, verbs);
        continue;
      }

      if (verbs && value instanceof AliasDescriptor) {
        registerAliasDescriptor(value, segments, [...dotPath, key], guards, meta, verbs);
        continue;
      }

      if (verbs && typeof value === 'function') {
        const paramNames = segments.filter((s) => s.type !== 'static').map((s) => s.param);
        routes.push({
          nodeId,
          dotPath: [...dotPath, key].join('.'),
          segments,
          paramNames,
          verbs,
          handler: value,
          isAsyncGen: value instanceof AsyncGeneratorFunction,
          guards,
          meta,
          nodeCache,
          ancestorCaches,
          nodeInFlight,
          nodeIdempotency
        });

        if (!hasExplicitDynamicChild) {
          const directChildSeg = {
            type: 'wild',
            priority: 5,
            param: 'id',
            optionalWild: true,
            directNodeParam: true,
            parse: null,
            raw: '$direct'
          };
          routes.push({
            nodeId: `${nodeId}_direct_${key}`,
            dotPath: [...dotPath, key].join('.'),
            segments: [...segments, directChildSeg],
            paramNames: [],
            verbs,
            handler: value,
            isAsyncGen: value instanceof AsyncGeneratorFunction,
            guards,
            meta,
            nodeCache,
            ancestorCaches,
            nodeInFlight,
            nodeIdempotency
          });
        }
        continue;
      }

      const paramRule = value?.[PARAM_META] ?? null;

      if (value instanceof StaticRouteDescriptor) {
        const seg = classifySegment(key, customTypes, paramRule);
        registerStaticDescriptor(value, [...segments, seg], [...dotPath, key], guards, meta);
        continue;
      }

      if (value instanceof RedirectDescriptor) {
        const seg = classifySegment(key, customTypes, paramRule);
        registerRedirectDescriptor(value, [...segments, seg], [...dotPath, key], guards, meta);
        continue;
      }

      if (value instanceof AliasDescriptor) {
        const seg = classifySegment(key, customTypes, paramRule);
        registerAliasDescriptor(value, [...segments, seg], [...dotPath, key], guards, meta);
        continue;
      }

      if (typeof value === 'function') {
        const seg = classifySegment(key, customTypes, paramRule);
        const childSegments = [...segments, seg];
        const paramNames = childSegments.filter((s) => s.type !== 'static').map((s) => s.param);
        const isAsyncGen = value instanceof AsyncGeneratorFunction;
        const fnGuards = [...guards, ...(value[GUARD_META] || [])];
        routes.push({
          nodeId: `${nodeId}_${key}`,
          dotPath: [...dotPath, key].join('.'),
          segments: childSegments,
          paramNames,
          verbs: [isAsyncGen ? 'GET' : 'POST'],
          handler: value,
          isAsyncGen,
          guards: fnGuards,
          meta,
          nodeCache: null,
          ancestorCaches: nextAncestorCaches,
          nodeInFlight: meta.coalesce ? new Map() : null,
          nodeIdempotency: meta.idempotent ? new Map() : null
        });
        continue;
      }

      if (value && typeof value === 'object') {
        const seg = classifySegment(key, customTypes, paramRule);
        walk(value, [...segments, seg], [...dotPath, key], guards, meta, nextAncestorCaches);
      }
    }
  }

  walk(apiRoot, [], [], [], {}, []);

  if (staticConfig) {
    if (typeof staticConfig === 'string' || staticConfig instanceof StaticRouteDescriptor) {
      const desc = staticConfig instanceof StaticRouteDescriptor
        ? staticConfig
        : new StaticRouteDescriptor(staticConfig);
      registerStaticDescriptor(desc, [], ['static'], [], {}, true);
    } else if (typeof staticConfig === 'object') {
      for (const [mountPrefix, target] of Object.entries(staticConfig)) {
        const desc = target instanceof StaticRouteDescriptor
          ? target
          : new StaticRouteDescriptor(target);
        const cleanPrefix = mountPrefix.replace(/^\/+|\/+$/g, '');
        const prefixSegs = cleanPrefix
          ? cleanPrefix.split('/').map((s) => classifySegment(s, customTypes))
          : [];
        registerStaticDescriptor(desc, prefixSegs, ['static', ...prefixSegs.map((s) => s.raw)], [], {}, prefixSegs.length === 0);
      }
    }
  }

  if (aliasConfig && typeof aliasConfig === 'object') {
    for (const [sourcePath, target] of Object.entries(aliasConfig)) {
      const desc = target instanceof AliasDescriptor
        ? target
        : new AliasDescriptor(target);
      const cleanPrefix = sourcePath.replace(/^\/+|\/+$/g, '');
      const prefixSegs = cleanPrefix
        ? cleanPrefix.split('/').map((s) => classifySegment(s, customTypes))
        : [];
      registerAliasDescriptor(
        desc,
        prefixSegs,
        ['alias', ...prefixSegs.map((s) => s.raw)],
        [],
        {}
      );
    }
  }

  routes.sort((a, b) => {
    const minLen = Math.min(a.segments.length, b.segments.length);
    for (let i = 0; i < minLen; i++) {
      if (a.segments[i].priority !== b.segments[i].priority) {
        return a.segments[i].priority - b.segments[i].priority;
      }
    }
    return a.segments.length - b.segments.length;
  });

  return routes;
}

export function matchDomainRoute(routes, method, pathname) {
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  const allowedVerbs = new Set();

  for (const route of routes) {
    const params = {};
    let matched = true;

    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i];
      if (seg.type === 'wild') {
        if (i >= parts.length && !seg.optionalWild) {
          matched = false;
          break;
        }
        try {
          const decodedParts = parts.slice(i).map(decodeURIComponent);
          if (seg.directNodeParam) {
            if (decodedParts.length === 1) {
              params.id = decodedParts[0];
            } else if (decodedParts.length > 1) {
              params.rest = decodedParts;
              params.id = decodedParts[0];
            }
          } else {
            params[seg.param] = decodedParts.join('/');
          }
        } catch {
          matched = false;
        }
        break;
      }
      if (i >= parts.length) {
        matched = false;
        break;
      }
      if (seg.type === 'param') {
        let decoded;
        try {
          decoded = decodeURIComponent(parts[i]);
        } catch {
          matched = false;
          break;
        }
        if (seg.parse) {
          const res = seg.parse(decoded);
          if (!res.ok) {
            matched = false;
            break;
          }
          params[seg.param] = res.value;
        } else {
          params[seg.param] = decoded;
        }
      } else if (seg.value !== parts[i]) {
        matched = false;
        break;
      }
    }

    const lastSeg = route.segments[route.segments.length - 1];
    if (matched && lastSeg?.type !== 'wild' && parts.length !== route.segments.length) {
      matched = false;
    }

    if (matched) {
      for (const v of route.verbs) {
        if (v !== 'WS') allowedVerbs.add(v);
      }
      if (route.verbs.includes(method)) {
        return { status: 200, route, params };
      }
    }
  }

  if (allowedVerbs.size > 0) {
    return { status: 405, allow: [...allowedVerbs].join(', ') };
  }
  return { status: 404 };
}

// export function generateVirtualClientModule(routes) {
//   const manifest = routes
//     .filter((r) => !r.staticDescriptor && !r.redirectDescriptor)
//     .map((r) => ({
//       dotPath: r.dotPath,
//       verbs: r.verbs,
//       isAsyncGen: r.isAsyncGen
//     }));

//   return `// Auto-generated Zero-Build Virtual ESM Client by servin
// const MANIFEST = ${JSON.stringify(manifest, null, 2)};
// const ORIGIN = new URL(import.meta.url).origin;
// const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// function parseMethod(key) {
//   if (key === 'ws') return 'WS';
//   const upper = key.split('|')[0].toUpperCase();
//   return HTTP_VERBS.has(upper) ? upper : null;
// }

// function isOptionsBag(arg) {
//   return Boolean(
//     arg &&
//     typeof arg === 'object' &&
//     !Array.isArray(arg) &&
//     !(arg instanceof FormData) &&
//     !(arg instanceof URLSearchParams) &&
//     !(arg instanceof Blob) &&
//     Object.prototype.hasOwnProperty.call(arg, 'headers')
//   );
// }

// function createNode(chain) {
//   return new Proxy(function () {}, {
//     get(_, prop) {
//       if (typeof prop === 'symbol') return undefined;
//       return createNode([...chain, prop]);
//     },
//     apply(_, __, args) {
//       const argQueue = [...args];
//       const dotKey = chain.join('.');
//       const entry = MANIFEST.find((m) => m.dotPath === dotKey);
//       const lastKey = chain[chain.length - 1];
//       let method = parseMethod(lastKey);
//       const pathSegments = method ? chain.slice(0, -1) : [...chain];

//       if (!method) {
//         method = entry?.verbs?.[0] || 'POST';
//       }

//       const resolvedParts = [];
//       for (const seg of pathSegments) {
//         if (seg.startsWith('$')) {
//           const val = argQueue.shift();
//           resolvedParts.push(encodeURIComponent(String(val ?? '')));
//         } else {
//           resolvedParts.push(encodeURIComponent(seg));
//         }
//       }

//       const pathname = '/' + resolvedParts.join('/');

//       if (method === 'WS') {
//         const wsOrigin = ORIGIN.replace(/^http/, 'ws');
//         const firstArg = argQueue.shift();
//         let connData = (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg))
//           ? { ...firstArg }
//           : {};

//         let socket = null;
//         let manualClose = false;
//         let hasConnectedOnce = false;
//         let lastSeq = 0;
//         let currentState = null;

//         const queue = [];
//         let notify = null;
//         let closed = false;

//         const listeners = {
//           open: new Set(),
//           close: new Set(),
//           error: new Set(),
//           event: new Set(),
//           broadcast: new Set()
//         };
//         const syncCallbacks = new Set();

//         const emitLocal = (type, detail) => {
//           const set = listeners[type];
//           if (!set) return;
//           for (const fn of set) fn(detail);
//         };

//         const notifySync = (meta) => {
//           for (const fn of syncCallbacks) {
//             fn(currentState, meta);
//           }
//         };

//         const buildWsUrl = () => {
//           const u = new URL(wsOrigin + pathname);
//           for (const [k, v] of Object.entries(connData)) {
//             if (v !== undefined && v !== null) {
//               u.searchParams.set(k, String(v));
//             }
//           }
//           if (lastSeq > 0) {
//             u.searchParams.set('__lastSeq', String(lastSeq));
//           }
//           return u.toString();
//         };

//         const connect = () => {
//           if (socket && socket.readyState <= WebSocket.OPEN) {
//             socket.close(1000, 'refresh');
//           }
//           manualClose = false;
//           closed = false;

//           const ws = new WebSocket(buildWsUrl());
//           socket = ws;

//           ws.addEventListener('open', () => {
//             const reconnected = hasConnectedOnce;
//             hasConnectedOnce = true;
//             emitLocal('open', { reconnected });
//           });

//           ws.addEventListener('message', (ev) => {
//             let data = ev.data;
//             if (typeof data === 'string') {
//               try { data = JSON.parse(data); } catch {}
//             }

//             if (data && typeof data === 'object') {
//               if (data.type === 'sync_snapshot') {
//                 currentState = data.state;
//                 if (typeof data.seq === 'number') lastSeq = data.seq;
//                 notifySync({
//                   seq: data.seq,
//                   room: data.room,
//                   fullSnapshot: true,
//                   replayed: false
//                 });
//                 return;
//               }
//               if (data.type === 'sync_patch') {
//                 currentState = data.state;
//                 if (typeof data.seq === 'number') lastSeq = data.seq;
//                 notifySync({
//                   seq: data.seq,
//                   room: data.room,
//                   meta: data.meta,
//                   fullSnapshot: false,
//                   replayed: Boolean(data.replayed)
//                 });
//                 return;
//               }
//               if (data.type === 'error') {
//                 emitLocal('error', data);
//                 return;
//               }
//               if (data.type === 'broadcast') {
//                 emitLocal('broadcast', data);
//                 return;
//               }
//               if (data.type === 'event') {
//                 emitLocal('event', data.payload);
//                 return;
//               }
//             }

//             queue.push(data);
//             if (notify) { notify(); notify = null; }
//           });

//           ws.addEventListener('close', (ev) => {
//             closed = true;
//             emitLocal('close', { code: ev.code, reason: ev.reason, manual: manualClose });
//             if (notify) { notify(); notify = null; }
//             if (!manualClose) {
//               setTimeout(() => connect(), 1000);
//             }
//           });

//           ws.addEventListener('error', () => {
//             emitLocal('error', { message: 'WEBSOCKET_ERROR' });
//           });
//         };

//         connect();

//         const clientWs = {
//           on(event, cb) {
//             if (listeners[event]) listeners[event].add(cb);
//             return clientWs;
//           },
//           off(event, cb) {
//             if (listeners[event]) listeners[event].delete(cb);
//             return clientWs;
//           },
//           sync(cb) {
//             syncCallbacks.add(cb);
//             if (currentState !== null) {
//               cb(currentState, { seq: lastSeq, fullSnapshot: true, replayed: false });
//             }
//             return clientWs;
//           },
//           emit(name, payload = {}) {
//             if (socket && socket.readyState === WebSocket.OPEN) {
//               socket.send(JSON.stringify({ type: 'action', name, payload }));
//             }
//             return clientWs;
//           },
//           refresh(nextData = null) {
//             if (nextData && typeof nextData === 'object') {
//               connData = { ...connData, ...nextData };
//             }
//             lastSeq = 0;
//             manualClose = true;
//             connect();
//             return clientWs;
//           },
//           resync(room = null) {
//             if (socket && socket.readyState === WebSocket.OPEN) {
//               socket.send(JSON.stringify({ type: 'resync', room }));
//             }
//             return clientWs;
//           },
//           send(data) {
//             const payload = (data instanceof Uint8Array || typeof data === 'string')
//               ? data
//               : JSON.stringify(data);
//             if (socket && socket.readyState === WebSocket.OPEN) {
//               socket.send(payload);
//             } else if (socket) {
//               socket.addEventListener('open', () => socket.send(payload), { once: true });
//             }
//           },
//           close(code = 1000, reason = '') {
// console.log({code,reason})
//             manualClose = true;
//             if (socket) socket.close(code, reason);
//           },
//           async *[Symbol.asyncIterator]() {
//             while (!closed || queue.length > 0) {
//               if (queue.length > 0) {
//                 yield queue.shift();
//               } else {
//                 await new Promise((r) => { notify = r; });
//               }
//             }
//           }
//         };

//         return clientWs;
//       }

//       let customHeaders = {};
//       let payload;
//       let queryObj;

//       const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

//       if (hasBody) {
//         const first = argQueue.shift();
//         if (isOptionsBag(first)) {
//           customHeaders = { ...first.headers };
//           payload = first.body !== undefined ? first.body : argQueue.shift();
//           queryObj = first.query !== undefined ? first.query : argQueue.shift();
//         } else {
//           payload = first;
//           const second = argQueue.shift();
//           if (isOptionsBag(second)) {
//             customHeaders = { ...second.headers };
//             queryObj = second.query !== undefined ? second.query : argQueue.shift();
//           } else {
//             queryObj = second;
//           }
//         }
//       } else {
//         const first = argQueue.shift();
//         if (isOptionsBag(first)) {
//           customHeaders = { ...first.headers };
//           queryObj = first.query !== undefined ? first.query : argQueue.shift();
//         } else {
//           queryObj = first;
//           const second = argQueue.shift();
//           if (isOptionsBag(second)) {
//             customHeaders = { ...second.headers };
//           }
//         }
//       }

//       const url = new URL(ORIGIN + pathname);
//       if (queryObj && typeof queryObj === 'object') {
//         for (const [k, v] of Object.entries(queryObj)) {
//           if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
//         }
//       }

//       if (entry?.isAsyncGen) {
//         return (async function* () {
//           const res = await fetch(url, {
//             method,
//             headers: { Accept: 'text/event-stream', ...customHeaders },
//             credentials: 'include'
//           });
//           if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
//           const reader = res.body.getReader();
//           const decoder = new TextDecoder();
//           let buffer = '';
//           while (true) {
//             const { done, value } = await reader.read();
//             if (done) break;
//             buffer += decoder.decode(value, { stream: true });
//             const blocks = buffer.split('\\n\\n');
//             buffer = blocks.pop() || '';
//             for (const block of blocks) {
//               const line = block.split('\\n').find((l) => l.startsWith('data:'));
//               if (line) yield JSON.parse(line.slice(5).trim());
//             }
//           }
//         })();
//       }

//       return (async () => {
//         const headers = { ...customHeaders };
//         let body;
//         if (hasBody && payload !== undefined) {
//           if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
//             headers['Content-Type'] = 'application/json';
//           }
//           body = typeof payload === 'string' ? payload : JSON.stringify(payload);
//         }
//         const res = await fetch(url, { method, headers, body, credentials: 'include' });
//         if (res.status === 204) return null;
//         const text = await res.text();
//         let data = text;
//         try { data = JSON.parse(text); } catch {}
//         if (!res.ok) {
//           throw Object.assign(new Error(data?.error || text || 'Request failed'), {
//             status: res.status,
//             data
//           });
//         }
//         return data;
//       })();
//     }
//   });
// }

// export const api = createNode([]);
// export default api;`;
// }

export function generateVirtualClientModule(routes) {
  const manifest = routes
    .filter((r) => !r.staticDescriptor && !r.redirectDescriptor && !r.aliasDescriptor)
    .map((r) => ({
      dotPath: r.dotPath,
      verbs: r.verbs,
      isAsyncGen: r.isAsyncGen
    }));

  return `// Auto-generated Zero-Build Virtual ESM Client by servin
const MANIFEST = ${JSON.stringify(manifest, null, 2)};
const ORIGIN = new URL(import.meta.url).origin;
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function parseMethod(key) {
  if (key === 'ws') return 'WS';
  const upper = key.split('|')[0].toUpperCase();
  return HTTP_VERBS.has(upper) ? upper : null;
}

function isOptionsBag(arg) {
  return Boolean(
    arg &&
    typeof arg === 'object' &&
    !Array.isArray(arg) &&
    !(arg instanceof FormData) &&
    !(arg instanceof URLSearchParams) &&
    !(arg instanceof Blob) &&
    Object.prototype.hasOwnProperty.call(arg, 'headers')
  );
}

function createNode(chain) {
  return new Proxy(function () {}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      return createNode([...chain, prop]);
    },
    apply(_, __, args) {
      const argQueue = [...args];
      const dotKey = chain.join('.');
      const entry = MANIFEST.find((m) => m.dotPath === dotKey);
      const lastKey = chain[chain.length - 1];
      let method = parseMethod(lastKey);
      const pathSegments = method ? chain.slice(0, -1) : [...chain];

      if (!method) {
        method = entry?.verbs?.[0] || 'POST';
      }

      const resolvedParts = [];
      for (const seg of pathSegments) {
        if (seg.startsWith('$')) {
          const val = argQueue.shift();
          resolvedParts.push(encodeURIComponent(String(val ?? '')));
        } else {
          resolvedParts.push(encodeURIComponent(seg));
        }
      }

      const pathname = '/' + resolvedParts.join('/');

      if (method === 'WS') {
        const wsOrigin = ORIGIN.replace(/^http/, 'ws');
        const firstArg = argQueue.shift();
        let connData = (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg))
          ? { ...firstArg }
          : {};

        let activeRoom = connData.room ? String(connData.room) : null;
        let socket = null;
        let manualClose = false;
        let hasConnectedOnce = false;
        let lastSeq = 0;
        let currentState = null;

        const queue = [];
        let notify = null;
        let closed = false;

        const listeners = {
          open: new Set(),
          close: new Set(),
          error: new Set(),
          event: new Set(),
          broadcast: new Set()
        };
        const syncCallbacks = new Set();

        const emitLocal = (type, detail) => {
          const set = listeners[type];
          if (!set) return;
          for (const fn of set) fn(detail);
        };

        const notifySync = (meta) => {
          for (const fn of syncCallbacks) {
            fn(currentState, meta);
          }
        };

        const buildWsUrl = () => {
          const u = new URL(wsOrigin + pathname);
          for (const [k, v] of Object.entries(connData)) {
            if (v !== undefined && v !== null) {
              u.searchParams.set(k, String(v));
            }
          }
          if (lastSeq > 0) {
            u.searchParams.set('__lastSeq', String(lastSeq));
          }
          return u.toString();
        };

        const isAllowedRoom = (msgRoom) => {
          if (!activeRoom) return true;
          return Boolean(msgRoom) && String(msgRoom) === activeRoom;
        };

        const connect = () => {
          if (socket && socket.readyState <= WebSocket.OPEN) {
            socket.close(1000, 'refresh');
          }
          manualClose = false;
          closed = false;

          const ws = new WebSocket(buildWsUrl());
          socket = ws;

          ws.addEventListener('open', () => {
            const reconnected = hasConnectedOnce;
            hasConnectedOnce = true;
            emitLocal('open', { reconnected });
          });

          ws.addEventListener('message', (ev) => {
            let data = ev.data;
            if (typeof data === 'string') {
              try { data = JSON.parse(data); } catch {}
            }

            if (data && typeof data === 'object') {
              if (data.type === 'sync_snapshot') {
                if (!isAllowedRoom(data.room)) return;
                currentState = data.state;
                if (typeof data.seq === 'number') lastSeq = data.seq;
                notifySync({
                  seq: data.seq,
                  room: data.room,
                  fullSnapshot: true,
                  replayed: false
                });
                return;
              }
              if (data.type === 'sync_patch') {
                if (!isAllowedRoom(data.room)) return;
                currentState = data.state;
                if (typeof data.seq === 'number') lastSeq = data.seq;
                notifySync({
                  seq: data.seq,
                  room: data.room,
                  meta: data.meta,
                  fullSnapshot: false,
                  replayed: Boolean(data.replayed)
                });
                return;
              }
              if (data.type === 'error') {
                emitLocal('error', data);
                return;
              }
              if (data.type === 'broadcast') {
                if (!data.global && !isAllowedRoom(data.room)) return;
                emitLocal('broadcast', data);
                return;
              }
              if (data.type === 'event') {
                emitLocal('event', data.payload);
                return;
              }
              if (typeof data.event === 'string' && listeners[data.event]) {
                emitLocal(data.event, data.data !== undefined ? data.data : data);
                return;
              }
            }

            queue.push(data);
            if (notify) { notify(); notify = null; }
          });

          ws.addEventListener('close', (ev) => {
            closed = true;
            emitLocal('close', { code: ev.code, reason: ev.reason, manual: manualClose });
            if (notify) { notify(); notify = null; }
            if (!manualClose) {
              setTimeout(() => connect(), 1000);
            }
          });

          ws.addEventListener('error', () => {
            emitLocal('error', { message: 'WEBSOCKET_ERROR' });
          });
        };

        connect();

        const clientWs = {
          on(event, cb) {
            if (!listeners[event]) listeners[event] = new Set();
            listeners[event].add(cb);
            return clientWs;
          },
          off(event, cb) {
            if (listeners[event]) listeners[event].delete(cb);
            return clientWs;
          },
          sync(cb) {
            syncCallbacks.add(cb);
            if (currentState !== null) {
              cb(currentState, {
                seq: lastSeq,
                room: activeRoom,
                fullSnapshot: true,
                replayed: false
              });
            }
            return clientWs;
          },
          emit(name, payload = {}) {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'action', name, payload }));
            }
            return clientWs;
          },
          refresh(nextData = null) {
            if (nextData && typeof nextData === 'object') {
              connData = { ...connData, ...nextData };
              if (nextData.room !== undefined) {
                activeRoom = nextData.room ? String(nextData.room) : null;
              }
            }
            currentState = null;
            lastSeq = 0;
            manualClose = true;
            connect();
            return clientWs;
          },
          resync(room = null) {
            if (room !== null && room !== undefined) {
              activeRoom = String(room);
              connData.room = activeRoom;
              currentState = null;
              lastSeq = 0;
            }
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'resync', room: room ?? activeRoom }));
            }
            return clientWs;
          },
          send(data) {
            const payload = (data instanceof Uint8Array || typeof data === 'string')
              ? data
              : JSON.stringify(data);
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(payload);
            } else if (socket) {
              socket.addEventListener('open', () => socket.send(payload), { once: true });
            }
          },
          close(code=1000, reason = '') {
          console.log({code,reason})
            manualClose = true;
            if (socket) socket.close(code, reason);
          },
          async *[Symbol.asyncIterator]() {
            while (!closed || queue.length > 0) {
              if (queue.length > 0) {
                yield queue.shift();
              } else {
                await new Promise((r) => { notify = r; });
              }
            }
          }
        };

        return clientWs;
      }

      let customHeaders = {};
      let payload;
      let queryObj;

      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

      if (hasBody) {
        const first = argQueue.shift();
        if (isOptionsBag(first)) {
          customHeaders = { ...first.headers };
          payload = first.body !== undefined ? first.body : argQueue.shift();
          queryObj = first.query !== undefined ? first.query : argQueue.shift();
        } else {
          payload = first;
          const second = argQueue.shift();
          if (isOptionsBag(second)) {
            customHeaders = { ...second.headers };
            queryObj = second.query !== undefined ? second.query : argQueue.shift();
          } else {
            queryObj = second;
          }
        }
      } else {
        const first = argQueue.shift();
        if (isOptionsBag(first)) {
          customHeaders = { ...first.headers };
          queryObj = first.query !== undefined ? first.query : argQueue.shift();
        } else {
          queryObj = first;
          const second = argQueue.shift();
          if (isOptionsBag(second)) {
            customHeaders = { ...second.headers };
          }
        }
      }

      const url = new URL(ORIGIN + pathname);
      if (queryObj && typeof queryObj === 'object') {
        for (const [k, v] of Object.entries(queryObj)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }

      if (entry?.isAsyncGen) {
        return (async function* () {
          const res = await fetch(url, {
            method,
            headers: { Accept: 'text/event-stream', ...customHeaders },
            credentials: 'include'
          });
          if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\\n\\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              const line = block.split('\\n').find((l) => l.startsWith('data:'));
              if (line) yield JSON.parse(line.slice(5).trim());
            }
          }
        })();
      }

      return (async () => {
        const headers = { ...customHeaders };
        let body;
        if (hasBody && payload !== undefined) {
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
          }
          body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        }
        const res = await fetch(url, { method, headers, body, credentials: 'include' });
        if (res.status === 204) return null;
        const text = await res.text();
        let data = text;
        try { data = JSON.parse(text); } catch {}
        if (!res.ok) {
          throw Object.assign(new Error(data?.error || text || 'Request failed'), {
            status: res.status,
            data
          });
        }
        return data;
      })();
    }
  });
}

export const api = createNode([]);
export default api;
`;
}