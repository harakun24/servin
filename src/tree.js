const GUARD_META = Symbol('servin.guard');
const PARAM_META = Symbol('servin.param');

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
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
  } else if (branch && typeof branch === 'object') {
    target = { ...branch };
  } else {
    throw new TypeError('Branch must be a route object or handler function');
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

export function compileDomainTree(apiRoot = {}, customTypes = {}) {
  const routes = [];
  let nodeCounter = 0;

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

    for (const [key, value] of Object.entries(node)) {
      if (META_KEYS.has(key)) continue;

      const verbs = parseVerbKey(key);
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
        continue;
      }

      const paramRule = value?.[PARAM_META] ?? null;

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
        params[seg.param] = parts.slice(i).map(decodeURIComponent).join('/');
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

export function generateVirtualClientModule(routes) {
  const manifest = routes.map((r) => ({
    dotPath: r.dotPath,
    verbs: r.verbs,
    isAsyncGen: r.isAsyncGen
  }));

  return `// Auto-generated Zero-Build Virtual ESM Client by servin
const MANIFEST = ${JSON.stringify(manifest, null, 2)};
const ORIGIN = new URL(import.meta.url).origin;

function parseMethod(key) {
  if (key === 'ws') return 'WS';
  const upper = key.split('|')[0].toUpperCase();
  const verbs = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  return verbs.has(upper) ? upper : null;
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
        const ws = new WebSocket(wsOrigin + pathname);
        const queue = [];
        let notify = null;
        let closed = false;

        ws.onmessage = (ev) => {
          let data = ev.data;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch {}
          }
          queue.push(data);
          if (notify) { notify(); notify = null; }
        };
        ws.onclose = () => {
          closed = true;
          if (notify) { notify(); notify = null; }
        };

        return {
          send(data) {
            const payload = (data instanceof Uint8Array || typeof data === 'string')
              ? data
              : JSON.stringify(data);
            if (ws.readyState === WebSocket.OPEN) ws.send(payload);
            else ws.addEventListener('open', () => ws.send(payload), { once: true });
          },
          close(code, reason) {
            ws.close(code, reason);
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
      }

      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      const payload = hasBody ? argQueue.shift() : undefined;
      const queryObj = argQueue.shift();
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
            headers: { Accept: 'text/event-stream' },
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
        const headers = {};
        let body;
        if (hasBody && payload !== undefined) {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(payload);
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