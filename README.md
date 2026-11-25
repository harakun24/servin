# servin

**A modern, zero-dependency Node.js web server built around _Domain-Tree Projection_ and _Ambient Wire_.**

`servin` lets you build HTTP APIs, HTML pages, Server-Sent Events (SSE), and WebSockets using plain JavaScript functions and nested object trees. Instead of manually wiring string paths, `(req, res)` handlers, and `next()` middleware chains, you express your backend as a clean JavaScript object hierarchy while `servin` handles routing, parameter type coercion, self-invalidating caching, session persistence, rate limiting, and protocol translation automatically.

---

## Table of Contents

1. [Why servin?](#1-why-servin)
2. [Requirements & Installation](#2-requirements--installation)
3. [Step-by-Step Walkthrough](#3-step-by-step-walkthrough)
   - [Step 1: Booting the Server (`serve`)](#step-1-booting-the-server-serve)
   - [Step 2: Understanding the URL Routing Paradigm & Adding `GET`](#step-2-understanding-the-url-routing-paradigm--adding-get)
   - [Step 3: Dynamic & Typed URL Parameters (`$id` + `param`)](#step-3-dynamic--typed-url-parameters-id--param)
   - [Step 4: Creating Resources with `POST`, Validation & Rollbacks](#step-4-creating-resources-with-post-validation--rollbacks)
   - [Step 5: Updating (`put|patch`), Deleting (`delete`) & Auto-Invalidating `cache`](#step-5-updating-putpatch-deleting-delete--auto-invalidating-cache)
   - [Step 6: Decoupled Side Effects (`reactTo`) & Serving HTML (`wire.html`)](#step-6-decoupled-side-effects-reactto--serving-html-wirehtml)
   - [Step 7: Complete Assembled Application](#step-7-complete-assembled-application)
4. [Server Configuration (`serve`)](#4-server-configuration-serve)
   - [4.1 Configuration Options Reference](#41-configuration-options-reference)
   - [4.2 Server Instance API](#42-server-instance-api)
5. [Domain-Tree Projection & Routing](#5-domain-tree-projection--routing)
   - [5.1 Static, Dynamic, Typed, and Wildcard Segments](#51-static-dynamic-typed-and-wildcard-segments)
   - [5.2 Automatic Route Matching Priority](#52-automatic-route-matching-priority)
   - [5.3 HTTP Methods, Method Unions & Shorthand Leaf Functions](#53-http-methods-method-unions--shorthand-leaf-functions)
   - [5.4 Predictable Handler Argument Mapping](#54-predictable-handler-argument-mapping)
   - [5.5 Typed Route Parameters (`param`) — Complete Type Guide](#55-typed-route-parameters-param--complete-type-guide)
6. [Automatic Response Formatting & HTML Rendering](#6-automatic-response-formatting--html-rendering)
   - [6.1 Content-Type Resolution Matrix](#61-content-type-resolution-matrix)
   - [6.2 XSS-Safe HTML Templates & Raw HTML (`wire.html`)](#62-xss-safe-html-templates--raw-html-wirehtml)
   - [6.3 Streaming Files with ETag & Byte-Range (`wire.file`)](#63-streaming-files-with-etag--byte-range-wirefile)
   - [6.4 Server-Sent Events (SSE) with Async Generators](#64-server-sent-events-sse-with-async-generators)
   - [6.5 Sparse Fieldsets (`?fields=`) & Automatic Redaction (`redact`)](#65-sparse-fieldsets-fields--automatic-redaction-redact)
7. [Security, Sessions & Traffic Control](#7-security-sessions--traffic-control)
   - [7.1 Branch & Leaf Protection (`guard`)](#71-branch--leaf-protection-guard)
   - [7.2 Lazy Reactive Sessions (`wire.session`) & Multi-Device Control (`wire.sessions`)](#72-lazy-reactive-sessions-wiresession--multi-device-control-wiresessions)
   - [7.3 Custom Session Store Interface (Redis / Database)](#73-custom-session-store-interface-redis--database)
   - [7.4 Timing-Safe Webhook Verification (`webhook`)](#74-timing-safe-webhook-verification-webhook)
   - [7.5 Context-Aware Smart Rate Limiting (`limit` & `wire.cost`)](#75-context-aware-smart-rate-limiting-limit--wirecost)
   - [7.6 CORS & Preflight Handling (`origins`)](#76-cors--preflight-handling-origins)
8. [Data Integrity, Caching & Resilience](#8-data-integrity-caching--resilience)
   - [8.1 Self-Invalidating Response Cache (`cache`)](#81-self-invalidating-response-cache-cache)
   - [8.2 Request Coalescing (`coalesce`)](#82-request-coalescing-coalesce)
   - [8.3 Idempotent Mutations (`idempotent`)](#83-idempotent-mutations-idempotent)
   - [8.4 Declarative Shape-by-Example Validation (`expect`)](#84-declarative-shape-by-example-validation-expect)
   - [8.5 Automatic Rollbacks (`wire.undo`) & Speculative Dry-Runs (`X-Simulate`)](#85-automatic-rollbacks-wireundo--speculative-dry-runs-x-simulate)
   - [8.6 Graceful Background Tasks (`wire.defer`)](#86-graceful-background-tasks-wiredefer)
   - [8.7 Adaptive Load Shedding (`priority: 'low'`) & API Deprecation (`sunset`)](#87-adaptive-load-shedding-priority-low--api-deprecation-sunset)
9. [Unified Linear WebSockets](#9-unified-linear-websockets)
   - [9.1 Linear WebSocket Streams (`ws` & `for await`)](#91-linear-websocket-streams-ws--for-await)
   - [9.2 Pub/Sub Topics & Cross-Protocol Messaging (`wire.publish`)](#92-pubsub-topics--cross-protocol-messaging-wirepublish)
   - [9.3 WebSocket Options (`wsConfig`) & Session Auto-Kick](#93-websocket-options-wsconfig--session-auto-kick)
10. [Streaming Uploads (`wire.multipart` & `rawBody`)](#10-streaming-uploads-wiremultipart--rawbody)
11. [Decoupled Side Effects (`reactTo`)](#11-decoupled-side-effects-reactto)
12. [Zero-Build Virtual ESM Client (`/@client.js`)](#12-zero-build-virtual-esm-client-clientjs)
13. [Observability, Logging & Automated Testing](#13-observability-logging--automated-testing)
    - [13.1 Custom Startup Messages & Access Logs (`message`, `onListen`, `accessLog`)](#131-custom-startup-messages--access-logs-message-onlisten-accesslog)
    - [13.2 Error-Triggered Debug Trace (`wire.log.debug`) & `Server-Timing` (`wire.mark`)](#132-error-triggered-debug-trace-wirelogdebug--server-timing-wiremark)
    - [13.3 Automated Test Synthesis (`synthesizeTests`)](#133-automated-test-synthesis-synthesizetests)
    - [13.4 Production Error Snapshots & Local Replay (`snapshotOnError` & `replay`)](#134-production-error-snapshots--local-replay-snapshotonerror--replay)
14. [Complete Ambient `wire` API Reference](#14-complete-ambient-wire-api-reference)
15. [License](#15-license)

---

## 1. Why servin?

Traditional Node.js web frameworks (Express, Fastify, Hono, Koa) rely on sequential middleware pipelines that mutate shared `req` or `ctx` objects and bind handlers to string URL patterns. As codebases expand, this architecture introduces hidden state mutations, manual cache-invalidation plumbing, and separate event-driven subsystems for WebSockets.

`servin` replaces string routing and middleware chains with two cohesive primitives:

1. **Domain-Tree Projection:** You define your backend as a standard nested JavaScript object. `servin` projects that object structure directly onto HTTP endpoints, SSE streams, WebSocket channels, and a zero-build frontend ES module (`/@client.js`).
2. **Ambient `wire`:** Backed by Node.js `AsyncLocalStorage`, `wire` gives any function in your call stack direct access to headers, status codes, sessions, rollbacks, background tasks, and pub/sub broadcasts without passing `req` or `res` arguments around.

| Capability               | Conventional Frameworks                                                                        | `servin`                                                                                                                     |
| :----------------------- | :--------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **Route Definition**     | String paths (`app.get('/users/:id', ...)`).                                                   | Plain JS object tree (`users: { $id: param('int', { get(id) { ... } }) }`).                                                  |
| **Parameter Validation** | Manual `Number(req.params.id)` + `Number.isNaN()` checks in every handler.                     | Declarative `param('int', branch)` validates before dispatch and passes typed values (`number`, `boolean`, `bigint`).        |
| **Cache Invalidation**   | Manual cache key tracking and deletion across update/delete routes.                            | `cache: '5m'` caches `GET` responses and automatically purges node and parent caches on `POST`, `PUT`, `PATCH`, or `DELETE`. |
| **Traffic Spikes**       | Concurrent requests execute redundant database queries unless custom locks are built.          | `coalesce: true` merges simultaneous identical `GET` requests into a single execution.                                       |
| **Session Overhead**     | Global middleware parses cookies and queries stores on every request, including public routes. | **Lazy Proxy:** zero cookie decryption or store lookups unless `wire.session` is actually read or written.                   |
| **WebSockets**           | Separate callback registration (`open`, `message`, `close`) detached from HTTP routes.         | Co-located `ws` method in the same domain tree using a linear `for await (const msg of socket)` loop.                        |
| **Frontend Integration** | Hand-written `fetch()` wrappers or build-time OpenAPI code generators.                         | Native browser/ESM import from `/@client.js` with zero build step.                                                           |

---

## 2. Requirements & Installation

- **Runtime:** Node.js `v20.0.0` or higher (uses native Web `Request`/`Response`, `WebSocket`, `AsyncLocalStorage`, and `node:test`).
- **Dependencies:** Zero external runtime dependencies.
- **Module System:** ES Modules (`"type": "module"` in `package.json`).

Install `servin`:

```bash
npm install servin
```

---

## 3. Step-by-Step Walkthrough

### Step 1: Booting the Server (`serve`)

Create a `server.js` file and call `serve()`. At its simplest, `serve()` binds an HTTP/WebSocket server to a port and prints a startup message:

```javascript
import { serve } from "servin";

await serve({
  port: 3000,
  message: ({ port, url }) => `Server is running on port ${port} (${url})`,
  api: {},
});
```

Run `node server.js` and your server is live on `http://127.0.0.1:3000`.

---

### Step 2: Understanding the URL Routing Paradigm & Adding `GET`

In `servin`, **you never write URL strings**. Instead, nested keys inside the `api` object automatically project into URL path segments, while lowercase HTTP verb names (`get`, `post`, `put`, `patch`, `delete`) act as the endpoint handlers:

```text
JavaScript Object Tree                 Projected HTTP Endpoint
─────────────────────────────────────────────────────────────────
api: {
  health: {
    get() { ... }          ──────►     GET /health
  },
  tasks: {
    get(query) { ... }     ──────►     GET /tasks  (and GET /tasks?done=false)
  }
}
```

Any plain object or array returned from `get()` is automatically serialized as `application/json` with status `200 OK`:

```javascript
import { serve } from "servin";

const tasksDb = new Map([
  [1, { id: 1, title: "Design domain tree", priority: "high", done: true }],
  [
    2,
    {
      id: 2,
      title: "Write integration tests",
      priority: "medium",
      done: false,
    },
  ],
]);

await serve({
  port: 3000,
  api: {
    // GET /health
    health: {
      get: () => ({ status: "ok" }),
    },

    // GET /tasks?done=false
    tasks: {
      get(query) {
        let list = [...tasksDb.values()];
        if (query.done === "true") list = list.filter((t) => t.done);
        if (query.done === "false") list = list.filter((t) => !t.done);
        return list;
      },
    },
  },
});
```

---

### Step 3: Dynamic & Typed URL Parameters (`$id` + `param`)

To capture a dynamic segment in the URL, prefix a key with `$` (such as `$id`). Wrapping that branch with `param('int', ...)` guarantees two things before your handler even runs:

1. **Automatic Filtering:** Non-integer URLs like `GET /tasks/abc` are rejected automatically (`404 Not Found`).
2. **Automatic Type Coercion:** The `id` argument passed to `get(id)` is already a JavaScript `number` (`1`), not a string (`"1"`).

```text
JavaScript Object Tree                 Projected HTTP Endpoint
─────────────────────────────────────────────────────────────────
tasks: {
  $id: param('int', {
    get(id) { ... }        ──────►     GET /tasks/1   (id === 1 as number)
  })                                   GET /tasks/abc (auto-rejected: 404)
}
```

Use `wire.abort(status, message)` whenever you need to halt execution and send an HTTP error response:

```javascript
import { serve, wire, param } from "servin";

// Inside api.tasks:
$id: param("int", {
  // GET /tasks/:id
  get(id) {
    const task = tasksDb.get(id);
    if (!task) wire.abort(404, `Task #${id} not found`);
    return task;
  },
});
```

---

### Step 4: Creating Resources with `POST`, Validation & Rollbacks

Add a `post(payload)` handler to `tasks` to handle `POST /tasks`. You can layer declarative safeguards directly onto the same object:

- `expect`: Validates the incoming JSON body shape before execution and returns `422 Unprocessable Entity` on invalid input.
- `idempotent: '10m'`: Prevents duplicate creation if a client retries a request with the same `Idempotency-Key` header.
- `wire.undo(fn)`: Registers a rollback action that automatically undoes the database write if a later step throws an error—or if the client sends `X-Simulate: true` for a dry-run.
- `wire.status(201)`: Sets the HTTP response status to `201 Created`.

```javascript
import { wire } from "servin";

let nextId = 3;

// Added directly inside api.tasks:
const createTaskRules = {
  expect: {
    title: "string",
    priority: ["low", "medium", "high"],
    done: "boolean?",
  },
  idempotent: "10m",
  post(payload) {
    const id = nextId++;
    const record = {
      id,
      title: payload.title,
      priority: payload.priority,
      done: payload.done ?? false,
    };

    tasksDb.set(id, record);
    wire.undo(() => tasksDb.delete(id));
    wire.status(201);
    return record;
  },
};
```

---

### Step 5: Updating (`put|patch`), Deleting (`delete`) & Auto-Invalidating `cache`

Now let's complete the CRUD lifecycle inside `$id` and add `cache: '5m'` to both `tasks` and `$id`:

- **Method Union (`'put|patch'`):** Handles both `PUT /tasks/:id` and `PATCH /tasks/:id` in one clean function, inspecting `wire.method` to distinguish full replacement from partial updates.
- **Self-Invalidating Cache:** When `GET /tasks` or `GET /tasks/1` is called, responses are served from cache. As soon as `POST`, `PUT`, `PATCH`, or `DELETE` succeeds, `servin` automatically purges both the item cache and the parent list cache.

```text
Cache Invalidation Flow
─────────────────────────────────────────────────────────────────
GET /tasks      ──► Cached for 5m
GET /tasks/1    ──► Cached for 5m
PATCH /tasks/1  ──► Succeeds ──► Automatically purges BOTH caches!
```

```javascript
import { wire, param } from "servin";

const taskItemNode = param("int", {
  cache: "5m",

  // GET /tasks/:id
  get(id) {
    const task = tasksDb.get(id);
    if (!task) wire.abort(404, `Task #${id} not found`);
    return task;
  },

  // PUT /tasks/:id & PATCH /tasks/:id
  "put|patch"(id, payload) {
    const existing = tasksDb.get(id);
    if (!existing) wire.abort(404, `Task #${id} not found`);

    const updated =
      wire.method === "PATCH"
        ? { ...existing, ...payload, id }
        : {
            id,
            title: payload.title,
            priority: payload.priority || "medium",
            done: Boolean(payload.done),
          };

    tasksDb.set(id, updated);
    return updated;
  },

  // DELETE /tasks/:id
  delete(id) {
    if (!tasksDb.has(id)) wire.abort(404, `Task #${id} not found`);
    tasksDb.delete(id);
    wire.status(204);
    return null;
  },
});
```

---

### Step 6: Decoupled Side Effects (`reactTo`) & Serving HTML (`wire.html`)

Finally, you can attach decoupled observers via `reactTo()` and serve an HTML frontend via `wire.html` that imports your backend tree directly from `/@client.js` with zero `fetch()` boilerplate:

```javascript
import { wire, reactTo } from "servin";

// Runs automatically after tasks.post succeeds (skipped during X-Simulate dry-runs)
reactTo(tasks.post, ({ output }) => {
  wire.log.info(`Created task #${output.id}: ${output.title}`);
});

// GET /home -> serves an HTML page with auto-escaped variables
const home = {
  get() {
    return wire.html`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>servin Tasks</title>
      </head>
      <body>
        <h1>Tasks (${tasksDb.size})</h1>
        <ul id="list"></ul>
        <script type="module">
          import { api } from '/@client.js';
          const items = await api.tasks.get();
          document.getElementById('list').innerHTML = items
            .map((t) => \`<li>[\${t.priority}] \${t.title}</li>\`)
            .join('');
        </script>
      </body>
      </html>
    `;
  },
};
```

---

### Step 7: Complete Assembled Application

Putting Steps 1 through 6 together produces a clean, self-contained application:

```javascript
import { serve, wire, param, reactTo } from "servin";

const tasksDb = new Map([
  [1, { id: 1, title: "Design domain tree", priority: "high", done: true }],
  [
    2,
    {
      id: 2,
      title: "Write integration tests",
      priority: "medium",
      done: false,
    },
  ],
]);
let nextId = 3;

const tasks = {
  cache: "5m",

  // GET /tasks?done=false
  get(query) {
    let list = [...tasksDb.values()];
    if (query.done === "true") list = list.filter((t) => t.done);
    if (query.done === "false") list = list.filter((t) => !t.done);
    return list;
  },

  // POST /tasks
  expect: {
    title: "string",
    priority: ["low", "medium", "high"],
    done: "boolean?",
  },
  idempotent: "10m",
  post(payload) {
    const id = nextId++;
    const record = {
      id,
      title: payload.title,
      priority: payload.priority,
      done: payload.done ?? false,
    };
    tasksDb.set(id, record);
    wire.undo(() => tasksDb.delete(id));
    wire.status(201);
    return record;
  },

  // /tasks/:id (integer-only)
  $id: param("int", {
    cache: "5m",

    get(id) {
      const task = tasksDb.get(id);
      if (!task) wire.abort(404, `Task #${id} not found`);
      return task;
    },

    "put|patch"(id, payload) {
      const existing = tasksDb.get(id);
      if (!existing) wire.abort(404, `Task #${id} not found`);

      const updated =
        wire.method === "PATCH"
          ? { ...existing, ...payload, id }
          : {
              id,
              title: payload.title,
              priority: payload.priority || "medium",
              done: Boolean(payload.done),
            };

      tasksDb.set(id, updated);
      return updated;
    },

    delete(id) {
      if (!tasksDb.has(id)) wire.abort(404, `Task #${id} not found`);
      tasksDb.delete(id);
      wire.status(204);
      return null;
    },
  }),
};

reactTo(tasks.post, ({ output }) => {
  wire.log.info(`Created task #${output.id}: ${output.title}`);
});

const home = {
  get() {
    return wire.html`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>servin Tasks</title>
      </head>
      <body>
        <h1>Tasks (${tasksDb.size})</h1>
        <ul id="list"></ul>
        <script type="module">
          import { api } from '/@client.js';
          const items = await api.tasks.get();
          document.getElementById('list').innerHTML = items
            .map((t) => \`<li>[\${t.priority}] \${t.title}</li>\`)
            .join('');
        </script>
      </body>
      </html>
    `;
  },
};

await serve({
  port: 3000,
  message: ({ port, url }) => `Server is running on port ${port} (${url})`,
  api: {
    home,
    tasks,
  },
});
```

---

## 4. Server Configuration (`serve`)

`serve(config)` compiles your domain tree, binds the HTTP and WebSocket servers, registers graceful shutdown hooks (`SIGINT` and `SIGTERM`), and resolves once the server is listening.

### 4.1 Configuration Options Reference

| Option            | Type                          | Default                         | Description                                                                                                                                                   |
| :---------------- | :---------------------------- | :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `port`            | `number`                      | `3000`                          | TCP port to listen on. Pass `0` to let the OS assign an available ephemeral port.                                                                             |
| `host`            | `string`                      | `'127.0.0.1'`                   | Network interface to bind (use `'0.0.0.0'` for containers/external access).                                                                                   |
| `api`             | `object`                      | `{}`                            | The root domain tree defining all HTTP routes, SSE streams, and WebSocket endpoints.                                                                          |
| `types`           | `object`                      | `{}`                            | Dictionary of named custom parameter rules (`RegExp` or validator functions) usable via `param('typeName', branch)`.                                          |
| `session`         | `object \| null`              | `null`                          | Enables encrypted lazy sessions. Requires `{ secret: string }`. See [Section 7.2](#72-lazy-reactive-sessions-wiresession--multi-device-control-wiresessions). |
| `origins`         | `string[]`                    | `undefined`                     | Allowed CORS origins (e.g., `['https://app.example.com']` or `['*']`). Automatically handles `OPTIONS` preflight requests and credentials.                    |
| `redact`          | `string[]`                    | `undefined`                     | Wildcard key patterns (e.g., `['password*', '*.secret', 'token']`) stripped recursively from all JSON responses.                                              |
| `message`         | `string \| function \| false` | `'[servin] listening on <url>'` | Custom startup log message. Accepts a string, `({ port, host, url }) => string`, or `false` to suppress.                                                      |
| `onListen`        | `function`                    | `undefined`                     | Sync or async callback `({ port, host, url }) => void` executed right after the port opens.                                                                   |
| `accessLog`       | `boolean \| function`         | `true`                          | Logs every HTTP and WebSocket request. Pass `false` to disable, or `(info) => string \| null` to customize/filter output.                                     |
| `silent`          | `boolean`                     | `false`                         | Suppresses both the startup message and access logs.                                                                                                          |
| `lagThresholdMs`  | `number`                      | `60`                            | Event-loop p95 latency threshold (in milliseconds) before `priority: 'low'` routes shed load with `503`.                                                      |
| `synthesizeTests` | `string`                      | `undefined`                     | File path (e.g., `'./tests/api.test.js'`) where verified request/response pairs are automatically written as `node:test` suites.                              |
| `snapshotOnError` | `string`                      | `undefined`                     | Directory path (e.g., `'./snapshots'`) where failing `500` request snapshots are saved for local `replay()`.                                                  |
| `onError`         | `function`                    | `undefined`                     | Custom unhandled error formatter `(err, { req }) => Response \| object`.                                                                                      |

### 4.2 Server Instance API

`await serve(config)` returns a control object:

```javascript
const app = await serve({
  port: 0,
  api: { health: { get: () => ({ ok: true }) } },
});

console.log(app.port); // Actual bound port (useful when port: 0 is used)
console.log(app.url); // e.g. "http://127.0.0.1:54321"

// Invoke the HTTP router directly in-memory without opening a network socket:
const res = await app.fetch(new Request("http://localhost/health"));
console.log(await res.json()); // { ok: true }

// Gracefully close the HTTP server and await all pending wire.defer() background tasks:
await app.close();
```

---

## 5. Domain-Tree Projection & Routing

### 5.1 Static, Dynamic, Typed, and Wildcard Segments

Every property key inside `api` corresponds to a URL path segment:

- **Static segment (`users`, `summary`):** Matches the exact path segment (`/users/summary`).
- **Untyped dynamic parameter (`$slug`, `$username`):** Matches any single non-empty URL segment and decodes URI components (`/posts/:slug`).
- **Typed dynamic parameter (`$id: param(...)`):** Validates and coerces the URL segment according to the specified rule. If validation fails, the route is skipped (resulting in `404 Not Found` or falling back to a lower-priority sibling route).
- **Wildcard catch-all (`$path`):** Matches all remaining trailing path segments joined with `/` (`/files/docs/2026/report.pdf` -> `path = "docs/2026/report.pdf"`).

```javascript
import { serve, param } from "servin";

await serve({
  port: 3000,
  api: {
    files: {
      // GET /files/a/b/c.txt -> path = "a/b/c.txt"
      $path: {
        get(path) {
          return { requestedPath: path };
        },
      },
    },
    users: {
      // 1. Static route: GET /users/me
      me: {
        get: () => ({ id: 0, username: "current_user" }),
      },
      // 2. Typed int route: GET /users/42
      $id: param("int", {
        get(id) {
          return { id, type: typeof id }; // { id: 42, type: "number" }
        },
      }),
      // 3. Fallback untyped route: GET /users/nadia
      $username: {
        get(username) {
          return { username, type: typeof username }; // { username: "nadia", type: "string" }
        },
      },
    },
  },
});
```

### 5.2 Automatic Route Matching Priority

Regardless of property definition order in your JavaScript objects, `servin` sorts compiled routes deterministically per segment from highest to lowest specificity:

1. **Priority 0 — Static segments** (`me`, `add`, `summary`)
2. **Priority 1 — Typed dynamic parameters** (`$id: param(...)`)
3. **Priority 2 — Untyped dynamic parameters** (`$username`)
4. **Priority 3 — Wildcard catch-all segments** (`$path`)

### 5.3 HTTP Methods, Method Unions & Shorthand Leaf Functions

Inside any route object, define handlers using lowercase HTTP verb keys:

- Standard HTTP verbs: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`
- WebSocket upgrade handler: `ws`
- **Method Unions:** Combine multiple verbs with `|` to share a single handler cleanly:

```javascript
const articles = {
  $id: param("int", {
    async "put|patch"(id, payload) {
      const isPartial = wire.method === "PATCH";
      return { id, isPartial, payload };
    },
  }),
};
```

- **Shorthand Leaf Functions:** Assigning a function directly to a non-verb key creates a leaf route automatically:
  - A standard function (`fn`) maps to **`POST`** on that path.
  - An async generator function (`async *fn()`) maps to **`GET`** streaming Server-Sent Events (`text/event-stream`).

```javascript
const system = {
  // Maps directly to POST /system/reboot
  reboot(payload) {
    return { rebooting: true, reason: payload.reason };
  },

  // Maps directly to GET /system/metrics (SSE stream)
  async *metrics() {
    yield { cpu: 12 };
    yield { cpu: 18 };
  },
};
```

### 5.4 Predictable Handler Argument Mapping

`servin` passes arguments to your handler functions in a strict, predictable order:

1. **Extracted URL parameters** (`$...` and `$path`) from left to right, already decoded and type-coerced.
2. **Parsed `payload`** (for body-bearing methods `POST`, `PUT`, `PATCH`, unless `rawBody: true` or streaming `multipart/form-data` is used).
3. **`query` object** (`Record<string, string>`) parsed from `url.searchParams` as the final argument.
4. For **`ws`** handlers: `(...extractedParams, socket)`.

```javascript
const orgs = {
  $orgId: param("int", {
    members: {
      $memberId: param("uuid", {
        // 1. orgId (number), 2. memberId (string), 3. payload (object), 4. query (object)
        patch(orgId, memberId, payload, query) {
          return { orgId, memberId, payload, notify: query.notify === "true" };
        },

        // 1. orgId (number), 2. memberId (string), 3. query (object)
        get(orgId, memberId, query) {
          return { orgId, memberId, includeRoles: query.roles === "1" };
        },
      }),
    },
  }),
};
```

### 5.5 Typed Route Parameters (`param`) — Complete Type Guide

Use `param(rule, branch)` on any `$`-prefixed key so your object keys remain clean JavaScript identifiers without string quotes. `param()` accepts **five kinds of rules**:

#### A. Built-in String Type Names

| Rule String | Validation Rule                                       | Coerced JS Type      | Matches Example                        | Rejects (`404`) Example               |
| :---------- | :---------------------------------------------------- | :------------------- | :------------------------------------- | :------------------------------------ |
| `'int'`     | Non-negative safe integer (`/^\d+$/`)                 | `number`             | `0`, `42`, `1005`                      | `-1`, `3.14`, `42abc`, `abc`          |
| `'number'`  | Signed integer or decimal (`/^-?\d+(?:\.\d+)?$/`)     | `number`             | `-10`, `42`, `19.99`                   | `10px`, `NaN`, `abc`                  |
| `'float'`   | Alias for `'number'`                                  | `number`             | `-0.5`, `12.34`                        | `abc`                                 |
| `'bigint'`  | Arbitrary-precision signed integer (`/^-?\d+$/`)      | `bigint`             | `9007199254740993`                     | `12.5`, `abc`                         |
| `'uuid'`    | Standard UUID v1–v5 (case-insensitive)                | `string` (lowercase) | `550e8400-e29b-41d4-a716-446655440000` | `not-a-uuid`, `12345`                 |
| `'alpha'`   | ASCII letters only (`/^[a-zA-Z]+$/`)                  | `string`             | `en`, `Indonesia`                      | `en2`, `en-US`                        |
| `'alnum'`   | ASCII letters and digits (`/^[a-zA-Z0-9]+$/`)         | `string`             | `v2026`, `user99`                      | `user-99`, `v2.0`                     |
| `'slug'`    | Lowercase kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) | `string`             | `hello-world-2026`                     | `Hello_World`, `-leading`             |
| `'bool'`    | `'true'`, `'1'`, `'false'`, `'0'` (case-insensitive)  | `boolean`            | `true`, `1`, `FALSE`, `0`              | `yes`, `no`, `2`                      |
| `'boolean'` | Alias for `'bool'`                                    | `boolean`            | `true`, `false`                        | `maybe`                               |
| `'string'`  | Any valid URI-decoded string                          | `string`             | `anything`                             | Invalid percent-encoding (`%E0%A4%A`) |

#### B. Native JavaScript Constructors

You can pass JavaScript built-in constructors directly:

- `param(Number, branch)` — equivalent to `'number'` (coerces to `number`)
- `param(Boolean, branch)` — equivalent to `'bool'` (coerces to `boolean`)
- `param(BigInt, branch)` — equivalent to `'bigint'` (coerces to `bigint`)
- `param(String, branch)` — equivalent to `'string'` (passes `string`)

#### C. Inline `RegExp` Literals

Pass any regular expression directly without string escaping:

```javascript
const catalog = {
  // Matches /catalog/PRD-1042, rejects /catalog/prd-1042
  $sku: param(/^[A-Z]{3}-\d{4}$/, {
    get(sku) {
      return { sku };
    },
  }),
};
```

#### D. Inline Validator & Transformer Functions

Pass a function `(raw: string) => parsedValue`. Returning `null`, `undefined`, `false`, or throwing an error rejects the route (`404`). Returning any other value passes that transformed value directly to your handler:

```javascript
const events = {
  // Parses YYYY-MM-DD directly into a JavaScript Date instance
  $date: param(
    (raw) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const d = new Date(`${raw}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    },
    {
      get(date) {
        // `date` is already a valid Date object
        return { iso: date.toISOString() };
      },
    },
  ),
};
```

#### E. Global Reusable Custom Types (`serve({ types })`)

Register custom types once in `serve()` and reference them by name anywhere in your domain tree:

```javascript
await serve({
  port: 3000,
  types: {
    invoiceId: /^INV-\d{6}$/,
    positiveInt: (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    },
  },
  api: {
    invoices: {
      $id: param("invoiceId", {
        get: (id) => ({ invoice: id }),
      }),
    },
    pages: {
      $page: param("positiveInt", {
        get: (page) => ({ page }),
      }),
    },
  },
});
```

---

## 6. Automatic Response Formatting & HTML Rendering

### 6.1 Content-Type Resolution Matrix

`servin` inspects the return value of your handler and constructs the HTTP response automatically:

| Handler Return Value            | Default HTTP Status   | `Content-Type` Header              | Behavior                                                                            |
| :------------------------------ | :-------------------- | :--------------------------------- | :---------------------------------------------------------------------------------- |
| Plain `Object` or `Array`       | `200`                 | `application/json; charset=utf-8`  | Applies `redact` rules and `?fields=` masks, then serializes to JSON.               |
| `wire.html(...)`                | `200`                 | `text/html; charset=utf-8`         | Sends rendered HTML string.                                                         |
| `wire.file(path)`               | `200` / `206` / `304` | Auto-detected from file extension  | Streams file from disk with `ETag` and `Accept-Ranges: bytes`.                      |
| `string`                        | `200`                 | `text/plain; charset=utf-8`        | Sends plain text (unless `Content-Type` was explicitly set via `wire.headers.set`). |
| `null` or `undefined`           | `204`                 | _(none)_                           | Sends an empty body (`204 No Content`, or explicit `wire.status(code)`).            |
| `async *generator()`            | `200`                 | `text/event-stream; charset=utf-8` | Streams yielded values as Server-Sent Events (`data: <json>\n\n`).                  |
| `ReadableStream` / `Uint8Array` | `200`                 | _(user-defined or default)_        | Streams raw binary bytes directly to the response.                                  |
| Web `Response`                  | `Response.status`     | `Response.headers`                 | Returned verbatim as-is.                                                            |

### 6.2 XSS-Safe HTML Templates & Raw HTML (`wire.html`)

Returning a plain `string` always defaults to `text/plain` to prevent accidental Cross-Site Scripting (XSS). To send HTML responses, use **`wire.html`**:

1. **Tagged Template Literal (Recommended):** Automatically HTML-escapes all interpolated variables (`&`, `<`, `>`, `"`, `'`), while preserving nested `wire.html` fragments and arrays of fragments unescaped.
2. **Direct Function Call:** `wire.html(rawHtmlString)` sends an already-trusted HTML string with `Content-Type: text/html; charset=utf-8`.

```javascript
import { serve, wire } from "servin";

await serve({
  port: 3000,
  api: {
    // 1. Tagged template with automatic XSS escaping and nested components
    greet: {
      $name: {
        get(name) {
          const badges = ["Admin", "Verified"].map(
            (b) => wire.html`<span class="badge">${b}</span>`,
          );

          // If `name` is "<script>alert(1)</script>", it is safely escaped to &lt;script&gt;...
          // Meanwhile `badges` (already HtmlResponse instances) render as real <span> tags.
          return wire.html`
            <!doctype html>
            <html>
              <body>
                <h1>Welcome, ${name}!</h1>
                <div class="badges">${badges}</div>
              </body>
            </html>
          `;
        },
      },
    },

    // 2. Direct string call
    banner: {
      get: () => wire.html('<div class="banner">System Operational</div>'),
    },

    // 3. Manual Content-Type header override on a plain string
    custom: {
      get() {
        wire.headers.set("content-type", "text/html; charset=utf-8");
        return "<p>Sent with explicit header</p>";
      },
    },
  },
});
```

### 6.3 Streaming Files with ETag & Byte-Range (`wire.file`)

`wire.file(filePath)` streams files directly from the filesystem without loading them into memory. It automatically:

- Resolves MIME types (`.html`, `.css`, `.js`, `.json`, `.svg`, `.png`, `.jpg`, `.webp`, `.pdf`, `.mp4`, `.mp3`, `.zip`, etc.).
- Computes weak `ETag` headers (`W/"<size>-<mtimeMs>"`) and responds with `304 Not Modified` when `If-None-Match` matches.
- Supports HTTP `Range: bytes=start-end` headers (`206 Partial Content` and `416 Range Not Satisfiable`) for audio/video scrubbing and resumable downloads.

```javascript
import path from "node:path";
import { serve, wire } from "servin";

const PAGES_DIR = path.resolve("./pages");

await serve({
  port: 3000,
  api: {
    // GET /home -> ./pages/home.html
    home: {
      get: () => wire.file("./pages/home.html"),
    },

    // GET /docs/guide -> ./pages/guide.html (with path-traversal protection)
    docs: {
      $slug: {
        get(slug) {
          const resolved = path.resolve(PAGES_DIR, `${slug}.html`);
          if (!resolved.startsWith(PAGES_DIR + path.sep)) {
            wire.abort(403, "Access denied");
          }
          return wire.file(resolved);
        },
      },
    },
  },
});
```

### 6.4 Server-Sent Events (SSE) with Async Generators

Define an `async *get()` method (or a leaf `async *name()`) to stream real-time events over HTTP. If the client closes the connection early, `servin` automatically invokes `iterator.return()` and runs any registered `wire.undo()` cleanup handlers:

```javascript
import { serve, wire } from "servin";

await serve({
  port: 3000,
  api: {
    notifications: {
      async *stream(query) {
        let count = 0;
        const interval = setInterval(() => {}, 1000);
        wire.undo(() => clearInterval(interval));

        while (!wire.signal.aborted && count < 5) {
          count++;
          yield {
            id: count,
            channel: query.channel || "general",
            ts: Date.now(),
          };
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
    },
  },
});
```

### 6.5 Sparse Fieldsets (`?fields=`) & Automatic Redaction (`redact`)

- **Global Field Redaction (`redact`):** Any matching key names or dot-paths configured in `serve({ redact: [...] })` are stripped recursively from all JSON responses before serialization and caching.
- **Client-Driven Sparse Fieldsets (`?fields=`):** Every `GET` endpoint returning a JSON object or array automatically supports `?fields=id,title,author.name` to trim unused properties before serialization.

```javascript
await serve({
  port: 3000,
  redact: ["password*", "*.secret", "internalNotes"],
  api: {
    users: {
      get: () => [
        {
          id: 1,
          name: "Nadia",
          passwordHash: "$2b$10$...", // Automatically stripped by `redact`
          profile: { email: "nadia@example.com", secret: "xyz" }, // `secret` stripped
        },
      ],
    },
  },
});
// GET /users?fields=id,profile.email -> [{ "id": 1, "profile": { "email": "nadia@example.com" } }]
```

---

## 7. Security, Sessions & Traffic Control

### 7.1 Branch & Leaf Protection (`guard`)

`guard(policyFn, branch)` attaches an authorization or precondition policy to an entire domain subtree or a single leaf route. Guards execute **before** request body parsing, **before** rate-limit accounting, and **before** WebSocket `101 Switching Protocols` handshakes. Multiple `guard()` wrappers compose cleanly from outer to inner branches.

```javascript
import { serve, wire, guard, param } from "servin";

function requireAuth() {
  if (!wire.session.userId) {
    wire.abort(401, "Authentication required");
  }
}

function requireAdmin() {
  if (wire.session.role !== "admin") {
    wire.abort(403, "Administrator privileges required");
  }
}

await serve({
  port: 3000,
  session: {
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
  },
  api: {
    // Public route: `wire.session` is never touched, incurring zero cookie/store overhead
    status: {
      get: () => ({ status: "healthy" }),
    },

    // Protected branch: requires authenticated user, and nested `admin` requires admin role
    account: guard(requireAuth, {
      profile: {
        get: () => ({ userId: wire.session.userId, role: wire.session.role }),
      },
      admin: guard(requireAdmin, {
        users: {
          $id: param("int", {
            delete: (id) => ({ deletedUserId: id }),
          }),
        },
      }),
    }),
  },
});
```

### 7.2 Lazy Reactive Sessions (`wire.session`) & Multi-Device Control (`wire.sessions`)

When `session: { secret }` is configured in `serve()`, `wire.session` provides an AES-256-GCM encrypted, HttpOnly cookie-backed session managed through a **Lazy Proxy**:

- **Zero Overhead on Public Routes:** If a handler never reads or writes `wire.session`, cookies are never decrypted and the session store is never queried.
- **Plain Object Semantics:** Assign or delete properties directly (`wire.session.userId = 42`, `delete wire.session.tempFlag`). Changes are persisted and `Set-Cookie` is emitted automatically before headers are sent.
- **Session Fixation Protection:** Call `await wire.session.rotate()` on login to issue a fresh session ID and invalidate the previous one.
- **Multi-Device Tracking & Cross-Protocol Auto-Kick:** Call `wire.session.bind(userId)` to associate the session with a user account. Setting `wire.session = null` on logout deletes the store record, clears the cookie, and **immediately closes all active WebSockets** bound to that session (`4001 Session revoked`).

```javascript
import { serve, wire, guard } from "servin";

await serve({
  port: 3000,
  session: {
    secret: "super-secret-key-at-least-32-chars",
    cookieName: "app_sid",
    ttl: "7d",
    rolling: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
  },
  api: {
    auth: {
      login: {
        async post({ email, password }) {
          const user = { id: 42, name: "Nadia", role: "admin" };

          await wire.session.rotate();
          wire.session.bind(user.id);
          wire.session.userId = user.id;
          wire.session.role = user.role;
          wire.session.device = wire.headers.get("user-agent") || "Unknown";

          return { id: user.id, name: user.name };
        },
      },

      logout: {
        post() {
          // Destroys store record, clears cookie, and kicks active WebSockets for this session
          wire.session = null;
          return { signedOut: true };
        },
      },

      devices: guard(
        () => {
          if (!wire.session.userId) wire.abort(401);
        },
        {
          // List all active sessions bound to the current user
          get: () => wire.sessions.list(wire.session.userId),

          // Revoke all other devices and close their active WebSockets
          revokeOthers: {
            async post() {
              const revokedCount = await wire.sessions.revokeOthers(
                wire.session.userId,
              );
              return { revokedCount };
            },
          },
        },
      ),
    },
  },
});
```

### 7.3 Custom Session Store Interface (Redis / Database)

By default, `servin` uses an in-memory store (`MemorySessionStore`). For multi-instance deployments, pass any custom store implementing `get`, `set`, `delete`, `listByUser`, and `revokeOthers`:

```javascript
const redisSessionStore = {
  async get(sid) {
    const raw = await redis.get(`sess:${sid}`);
    return raw ? JSON.parse(raw) : null; // { userId, data, createdAt, updatedAt, expiresAt }
  },
  async set(sid, record) {
    const ttlSec = Math.max(
      1,
      Math.ceil((record.expiresAt - Date.now()) / 1000),
    );
    await redis.set(`sess:${sid}`, JSON.stringify(record), "EX", ttlSec);
    if (record.userId != null) {
      await redis.sadd(`user_sess:${record.userId}`, sid);
    }
  },
  async delete(sid) {
    const existing = await this.get(sid);
    if (existing?.userId != null) {
      await redis.srem(`user_sess:${existing.userId}`, sid);
    }
    await redis.del(`sess:${sid}`);
  },
  async listByUser(userId) {
    const sids = await redis.smembers(`user_sess:${userId}`);
    const out = [];
    for (const sid of sids) {
      const rec = await this.get(sid);
      if (rec) {
        out.push({
          id: sid.slice(0, 8),
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          device: rec.data?.device,
        });
      }
    }
    return out;
  },
  async revokeOthers(userId, currentSid) {
    const sids = await redis.smembers(`user_sess:${userId}`);
    const revoked = [];
    for (const sid of sids) {
      if (sid !== currentSid) {
        await this.delete(sid);
        revoked.push(sid);
      }
    }
    return revoked;
  },
};

await serve({
  port: 3000,
  session: { secret: process.env.SESSION_SECRET, store: redisSessionStore },
  api: {
    /* ... */
  },
});
```

### 7.4 Timing-Safe Webhook Verification (`webhook`)

Add `webhook: { secret, header, algo }` to any endpoint to verify HMAC signatures over the raw request body using `crypto.timingSafeEqual` before JSON parsing occurs. Supports raw hex digests as well as prefixed signatures (`sha256=...`):

```javascript
export const webhooks = {
  stripe: {
    webhook: {
      secret: process.env.STRIPE_WEBHOOK_SECRET,
      header: "stripe-signature",
      algo: "sha256",
    },
    async post(event) {
      // Only reached if HMAC signature is valid
      return { received: true, type: event.type };
    },
  },
};
```

### 7.5 Context-Aware Smart Rate Limiting (`limit` & `wire.cost`)

Configure `limit: { max, window, key }` on any node to enforce sliding point-bucket rate limits. By default, each request deducts `1` point. Inside your handler, call `wire.cost(points)` to dynamically adjust the cost—for example, charging `5` points on a failed password attempt and `0` points on a valid login:

```javascript
import { wire } from "servin";

export const login = {
  limit: {
    max: 15,
    window: "10m",
    key: (payload) => `login:${payload?.email || "anon"}`,
  },
  async post(payload) {
    const user = await verifyUser(payload.email, payload.password);
    if (!user) {
      wire.cost(5); // Penalize failed login attempts heavily
      wire.abort(401, "Invalid email or password");
    }
    wire.cost(0); // Successful logins consume 0 quota
    return { id: user.id };
  },
};
```

### 7.6 CORS & Preflight Handling (`origins`)

Pass `origins` to `serve()` to enable Cross-Origin Resource Sharing with credentials and automatic `OPTIONS` preflight responses:

```javascript
await serve({
  port: 3000,
  origins: ["https://app.example.com", "http://localhost:5173"],
  api: {
    /* ... */
  },
});
```

---

## 8. Data Integrity, Caching & Resilience

### 8.1 Self-Invalidating Response Cache (`cache`)

Setting `cache: '<duration>'` (e.g., `'30s'`, `'5m'`, `'1h'`) on a domain node caches `GET` responses keyed by route parameters and query string. Whenever a mutating method (`POST`, `PUT`, `PATCH`, `DELETE`) succeeds on that node—or on any child branch beneath it—`servin` automatically invalidates both the node's cache entries and any ancestor caches:

```javascript
export const posts = {
  cache: "10m", // Caches GET /posts
  get: () => db.posts.findAll(),
  post: (data) => db.posts.create(data), // Automatically purges GET /posts cache

  $id: param("int", {
    cache: "10m", // Caches GET /posts/:id
    get: (id) => db.posts.findById(id),
    patch: (id, data) => db.posts.update(id, data), // Purges BOTH GET /posts/:id AND GET /posts
    delete: (id) => db.posts.delete(id), // Purges BOTH GET /posts/:id AND GET /posts
  }),
};
```

### 8.2 Request Coalescing (`coalesce`)

Set `coalesce: true` on expensive `GET` endpoints to deduplicate concurrent identical requests. If 500 clients hit the same URL at the exact same millisecond on a cold cache, the handler executes **once** and all 500 callers receive the resolved result together:

```javascript
export const analytics = {
  dashboard: {
    coalesce: true,
    cache: "1m",
    async get() {
      return await db.runHeavyAggregationQuery();
    },
  },
};
```

### 8.3 Idempotent Mutations (`idempotent`)

Set `idempotent: '<duration>'` on mutating endpoints to deduplicate retries carrying the same `Idempotency-Key` HTTP header:

```javascript
export const transfers = {
  idempotent: "24h",
  async post(payload) {
    // Retries with the same Idempotency-Key return the original response without re-running
    return await ledger.transfer(payload);
  },
};
```

### 8.4 Declarative Shape-by-Example Validation (`expect`)

Define `expect` on any node with `POST`, `PUT`, or `PATCH` handlers to validate request payloads before execution. Invalid payloads automatically return `422 Unprocessable Entity` with structured field-level error details:

Supported field rules:

- Primitive types: `'string'`, `'number'`, `'boolean'`, `'array'`
- Built-in format: `'email'`
- Optional fields: append `?` (e.g., `'string?'`, `'number?'`, `'email?'`)
- Enum values: pass an array of allowed literals (e.g., `['free', 'pro', 'enterprise']`)
- Nested objects: nest another schema object

```javascript
export const users = {
  register: {
    expect: {
      email: "email",
      age: "number",
      plan: ["free", "pro"],
      bio: "string?",
      tags: "array?",
      preferences: {
        newsletter: "boolean",
      },
    },
    post(payload) {
      return { created: true, user: payload };
    },
  },
};
```

### 8.5 Automatic Rollbacks (`wire.undo`) & Speculative Dry-Runs (`X-Simulate`)

Register compensating actions via `wire.undo(fn)` right after each side-effecting step. If any subsequent step throws an error or calls `wire.abort()`, `servin` executes all registered undo callbacks in reverse order (**LIFO**).

Additionally, sending **`X-Simulate: true`** in the request headers executes your real handler logic to compute the exact response and status code, then automatically triggers the `wire.undo()` stack before returning—enabling zero-duplication dry-runs and transaction previews:

```javascript
import { wire } from "servin";

export const checkout = {
  async post(order) {
    const hold = await inventory.reserve(order.items);
    wire.undo(() => inventory.release(hold.id));

    const payment = await billing.charge(order.userId, order.total);
    wire.undo(() => billing.refund(payment.id));

    // If dispatch fails—or if the client sent `X-Simulate: true`—both
    // `billing.refund` and `inventory.release` run automatically in reverse order.
    const shipment = await shipping.dispatch(hold.id, order.address);

    wire.status(201);
    return { trackingId: shipment.id, totalCharged: order.total };
  },
};
```

### 8.6 Graceful Background Tasks (`wire.defer`)

Use `wire.defer(fn)` to schedule non-blocking tasks (such as sending emails, webhooks, or audit logs) after the HTTP response is sent. `servin` tracks all active deferred promises and awaits their completion during `SIGTERM` / `SIGINT` / `app.close()` shutdowns:

```javascript
import { wire } from "servin";

export const orders = {
  async post(payload) {
    const order = await db.orders.insert(payload);

    wire.defer(async () => {
      await mailer.sendReceipt(order.email, order.id);
    });

    wire.status(201);
    return order;
  },
};
```

### 8.7 Adaptive Load Shedding (`priority: 'low'`) & API Deprecation (`sunset`)

- **Adaptive Load Shedding:** Mark non-critical endpoints (like exports or recommendations) with `priority: 'low'`. When the Node.js event-loop p95 delay exceeds `lagThresholdMs` (default `60ms`), `servin` automatically sheds those requests with `503 Service Unavailable` and `Retry-After: 2` to protect critical traffic.
- **API Sunset Headers:** Set `sunset: '2027-01-01'` on legacy endpoints to automatically attach standard `Deprecation: true` and `Sunset` HTTP headers.

```javascript
export const legacy = {
  sunset: "2027-06-01T00:00:00Z",
  exportCsv: {
    priority: "low",
    get: () => generateLargeCsvReport(),
  },
};
```

---

## 9. Unified Linear WebSockets

### 9.1 Linear WebSocket Streams (`ws` & `for await`)

WebSocket endpoints live directly inside your domain tree as a `ws` method. Guards, typed parameters (`param()`), and lazy sessions (`wire.session`) all execute prior to the `101 Switching Protocols` handshake. Inside `ws`, you write the entire connection lifecycle linearly using `for await (const msg of socket)`:

```javascript
import { serve, wire, guard, param } from "servin";

const requireUser = () => {
  if (!wire.session.userId) wire.abort(401, "Sign in required");
};

await serve({
  port: 3000,
  session: { secret: "super-secret-key-at-least-32-chars" },
  api: {
    rooms: guard(requireUser, {
      $id: param("slug", {
        // HTTP GET /rooms/general
        get: (id) => ({ room: id, active: true }),

        // WS /rooms/general
        async ws(id, socket) {
          const topic = `room:${id}`;
          const joinedAt = Date.now();

          socket.join(topic);
          socket.send({ type: "welcome", room: id, user: wire.session.userId });
          socket.broadcast(topic, {
            type: "user_joined",
            user: wire.session.userId,
          });

          // Runs automatically when the client disconnects or session is revoked
          wire.undo(() => {
            socket.broadcast(topic, {
              type: "user_left",
              user: wire.session.userId,
              connectedMs: Date.now() - joinedAt,
            });
          });

          for await (const message of socket) {
            wire.publish(topic, {
              type: "chat",
              from: wire.session.userId,
              text: message.text,
            });
          }
        },
      }),
    }),
  },
});
```

### 9.2 Pub/Sub Topics & Cross-Protocol Messaging (`wire.publish`)

Any HTTP handler can broadcast real-time messages to subscribed WebSocket clients using `wire.publish(topic, data)`:

```javascript
export const orders = {
  $id: param("int", {
    approve: {
      async post(id) {
        const updated = await db.orders.markApproved(id);
        // Pushes live update to all WebSocket clients subscribed to `order:42`
        wire.publish(`order:${id}`, { event: "approved", order: updated });
        return updated;
      },
    },
  }),
};
```

**Linear Socket Methods & Properties:**

- `for await (const msg of socket)` — Yields parsed JSON objects (or `Uint8Array` for binary frames).
- `socket.send(data)` — Sends JSON-serialized data or raw `Uint8Array` binary frames to this client.
- `socket.join(topic)` / `socket.leave(topic)` — Subscribes or unsubscribes the socket from a topic (automatically cleaned up on disconnect).
- `socket.broadcast(topic, data)` — Sends `data` to all subscribers of `topic` _except_ the sender.
- `socket.close(code, reason)` — Closes the WebSocket connection cleanly.
- `socket.isOpen` — Boolean indicating whether the underlying TCP socket is open.
- `socket.bufferedAmount` — Bytes currently queued in the socket write buffer.

### 9.3 WebSocket Options (`wsConfig`) & Session Auto-Kick

Customize frame limits, ping/pong heartbeats, and binary mode per branch using `wsConfig`:

```javascript
export const telemetry = {
  wsConfig: {
    maxPayload: "256kb",
    heartbeat: "30s", // Automatically sends WebSocket Ping frames and closes unresponsive clients
    binary: true, // Delivers incoming frames as Uint8Array
  },
  async ws(socket) {
    for await (const chunk of socket) {
      socket.send(chunk); // Echo binary Uint8Array
    }
  },
};
```

---

## 10. Streaming Uploads (`wire.multipart` & `rawBody`)

### Streaming `multipart/form-data` (`wire.multipart`)

`wire.multipart(opts)` parses incoming multipart streams sequentially without buffering entire file uploads into RAM:

```javascript
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { wire } from "servin";

export const uploads = {
  async post() {
    const metadata = {};
    const uploadedFiles = [];

    for await (const part of wire.multipart({ maxFileSize: "50mb" })) {
      if (part.isField) {
        metadata[part.name] = await part.text();
      } else if (part.isFile) {
        const dest = `./uploads/${Date.now()}-${part.filename}`;
        await pipeline(
          Readable.fromWeb(part.stream),
          fs.createWriteStream(dest),
        );
        uploadedFiles.push({
          field: part.name,
          filename: part.filename,
          savedTo: dest,
        });
      }
    }

    wire.status(201);
    return { metadata, uploadedFiles };
  },
};
```

### Raw Unbuffered Binary Uploads (`rawBody: true`)

Set `rawBody: true` on a route to skip body parsing and pipe `wire.stream` directly:

```javascript
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { wire } from "servin";

export const blobs = {
  $name: {
    rawBody: true,
    async put(name) {
      await pipeline(
        Readable.fromWeb(wire.stream),
        fs.createWriteStream(`./storage/${name}`),
      );
      wire.status(201);
      return { stored: name };
    },
  },
};
```

---

## 11. Decoupled Side Effects (`reactTo`)

Use `reactTo(targetHandlerFn, observerFn)` to attach cross-cutting side effects (loyalty points, analytics, audit logs) from separate modules without cluttering core domain handlers. `reactTo` returns an unsubscribe function and never runs when `X-Simulate: true` is active:

```javascript
import { reactTo } from "servin";
import { orders } from "./modules/orders.js";

const unsubscribe = reactTo(orders.post, async ({ input, output, wire }) => {
  if (output.total >= 100) {
    await db.loyalty.addPoints(output.userId, 50);
  }
});
```

---

## 12. Zero-Build Virtual ESM Client (`/@client.js`)

`servin` automatically serves a dynamic ES module at **`GET /@client.js`** mirroring your exact domain tree. Frontend apps can import `api` directly in the browser without `fetch()` boilerplate, URL string interpolation, or build steps:

```javascript
// In your frontend application (Browser / React / Vue / Svelte / Vanilla JS)
import { api } from "http://localhost:3000/@client.js";

// 1. GET /tasks?done=false
const pendingTasks = await api.tasks.get({ done: "false" });

// 2. GET /tasks/1 (typed parameter)
const task = await api.tasks.$id.get(1);

// 3. POST /tasks
const created = await api.tasks.post({ title: "Ship v1.0", priority: "high" });

// 4. Method union PUT|PATCH /tasks/1
const updated = await api.tasks.$id["put|patch"](1, { done: true });

// 5. DELETE /tasks/1 -> returns null on 204
await api.tasks.$id.delete(1);

// 6. Server-Sent Events (async generator endpoint)
for await (const event of api.notifications.stream({ channel: "alerts" })) {
  console.log("SSE event:", event);
}

// 7. WebSocket connection (ws endpoint)
const room = api.rooms.$id.ws("general");
room.send({ text: "Hello from the browser!" });

for await (const msg of room) {
  console.log("WS message:", msg);
}
```

---

## 13. Observability, Logging & Automated Testing

### 13.1 Custom Startup Messages & Access Logs (`message`, `onListen`, `accessLog`)

`servin` logs incoming HTTP and WebSocket traffic automatically (`[servin] GET /tasks 200 1.2ms [CACHE]`) and prints a startup message when ready. Both can be customized or disabled:

```javascript
import { serve } from "servin";

await serve({
  port: 3000,

  // Custom startup message (string, function, or false)
  message: ({ port, url }) => `Server is running on port ${port} -> ${url}`,

  // Optional async hook once listening
  async onListen({ port }) {
    console.log(`Health check ready at http://127.0.0.1:${port}/health`);
  },

  // Custom access log formatter & filter (or pass `accessLog: false` to disable)
  accessLog(info) {
    if (info.url.pathname === "/health") return null; // Skip noisy healthchecks
    const cacheTag = info.cached ? " [CACHE]" : "";
    return `[${info.status}] ${info.method} ${info.url.pathname} (${info.durationMs.toFixed(1)}ms)${cacheTag}`;
  },

  api: {
    health: { get: () => ({ status: "ok" }) },
  },
});
```

### 13.2 Error-Triggered Debug Trace (`wire.log.debug`) & `Server-Timing` (`wire.mark`)

- **`wire.log.debug(msg, meta)`:** Buffers diagnostic logs per request in memory and **only prints them to stderr if the request fails with an unhandled error**, keeping production logs clean during normal traffic while providing full execution traces on failures.
- **`wire.mark(label)`:** Measures sub-operation durations and emits them in the standard HTTP `Server-Timing` response header.

```javascript
import { wire } from "servin";

export const reports = {
  async get() {
    wire.log.debug("Starting report generation", {
      userId: wire.session.userId,
    });

    const endDb = wire.mark("db");
    const rows = await db.reports.fetch();
    endDb();

    const endFormat = wire.mark("format");
    const summary = formatSummary(rows);
    endFormat();

    // Emits header: Server-Timing: db;dur=14.20, format;dur=1.85
    return summary;
  },
};
```

### 13.3 Automated Test Synthesis (`synthesizeTests`)

During local development, set `synthesizeTests: './tests/generated.test.js'`. As you exercise endpoints manually or via your frontend, `servin` records verified inputs, status codes, and response shapes and writes a standalone `node:test` file automatically.

### 13.4 Production Error Snapshots & Local Replay (`snapshotOnError` & `replay`)

Set `snapshotOnError: './snapshots'` to capture full request metadata whenever an unhandled `500` error occurs. You can replay the exact failing request locally against your handler function using `replay()` from `servin/test`:

```javascript
import { replay } from "servin/test";
import { users } from "./modules/users.js";

// Re-executes the failing handler locally with captured URL, headers, and extracted parameters
await replay(
  users.$id.get,
  "./snapshots/err-2026-11-25T12-00-00-000Z-a1b2c3d4.json",
);
```

---

## 14. Complete Ambient `wire` API Reference

| Property / Method           | Type / Signature                      | Description                                                                                                                              |
| :-------------------------- | :------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `wire.req`                  | `Request`                             | Underlying Web Fetch `Request` object.                                                                                                   |
| `wire.method`               | `string`                              | Uppercase HTTP method (`'GET'`, `'POST'`, etc.) or `'WS'`.                                                                               |
| `wire.url`                  | `URL`                                 | Parsed `URL` instance for the active request.                                                                                            |
| `wire.headers`              | `Headers` (Proxy)                     | `.get()` / `.has()` reads outgoing headers then incoming request headers; `.set()` / `.append()` / `.delete()` mutates response headers. |
| `wire.stream`               | `ReadableStream \| null`              | Unbuffered request body byte stream.                                                                                                     |
| `wire.signal`               | `AbortSignal`                         | Triggered when the client disconnects or aborts the request.                                                                             |
| `wire.status(code)`         | `(number) => void`                    | Sets the HTTP response status code.                                                                                                      |
| `wire.abort(status, msg)`   | `(number, string) => never`           | Immediately halts execution, runs `wire.undo()`, and sends `{ error: msg }`.                                                             |
| `wire.undo(fn)`             | `(() => any) => void`                 | Registers a LIFO rollback callback run on errors, aborts, SSE cancel, or `X-Simulate: true`.                                             |
| `wire.defer(fn)`            | `(() => any) => void`                 | Queues post-response background tasks tracked during graceful shutdown.                                                                  |
| `wire.html`                 | `tag \| (string) => HtmlResponse`     | Tagged template literal (auto-escaping XSS) or raw HTML response helper.                                                                 |
| `wire.file(path)`           | `(string) => FileStreamResponse`      | Streams a file with automatic MIME, `ETag` (`304`), and `Range` (`206`).                                                                 |
| `wire.multipart(opts)`      | `({ maxFileSize }) => AsyncGenerator` | Streams `multipart/form-data` fields and files sequentially without buffering in RAM.                                                    |
| `wire.session`              | `Proxy`                               | Lazy encrypted session object (`rotate()`, `bind(uid)`, `id`, `= null` to destroy).                                                      |
| `wire.sessions`             | `{ list, revokeOthers }`              | Multi-device session listing and remote WebSocket revocation per `userId`.                                                               |
| `wire.publish(topic, data)` | `(string, any) => void`               | Broadcasts data to all WebSocket clients subscribed to `topic`.                                                                          |
| `wire.cost(points)`         | `(number) => void`                    | Sets the dynamic rate-limit point cost for the current request.                                                                          |
| `wire.log.debug(msg, meta)` | `(string, any) => void`               | Request-scoped debug log printed only if an unhandled error occurs.                                                                      |
| `wire.log.info(msg, meta)`  | `(string, any) => void`               | Structured request-tagged console log.                                                                                                   |
| `wire.mark(label)`          | `(string) => () => void`              | Starts a performance timer and returns a stop function recorded in `Server-Timing`.                                                      |

---

## 15. License

MIT
