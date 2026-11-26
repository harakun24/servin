# servin

**A modern, zero-dependency Node.js web server built around _Domain-Tree Projection_ and _Ambient Wire_.**

`servin` lets you build HTTP APIs, static websites, HTML pages, Server-Sent Events (SSE), and WebSockets using plain JavaScript functions and nested object trees. Instead of manually wiring string paths, `(req, res)` handlers, and `next()` middleware chains, you express your backend as a clean JavaScript object hierarchy while `servin` handles routing, parameter type coercion, self-invalidating caching, session persistence, rate limiting, and zero-build frontend client generation automatically.

[see the real example usage here](https://github.com/harakun24/webserver-example)

## Table of Contents

1. [Why servin?](#1-why-servin)
2. [Requirements & Installation](#2-requirements--installation)
3. [Step-by-Step Core Walkthrough](#3-step-by-step-core-walkthrough)
   - [Step 1: Starting the Server (`serve`)](#step-1-starting-the-server-serve)
   - [Step 2: How URL Routing Works & Your First `GET`](#step-2-how-url-routing-works--your-first-get)
   - [Step 3: Reading URL Query Parameters (`?done=true`)](#step-3-reading-url-query-parameters-donetrue)
   - [Step 4: Dynamic URL Segments (`$id`) & Type Rules (`param`)](#step-4-dynamic-url-segments-id--type-rules-param)
   - [Step 5: Creating Data with a Simple `POST`](#step-5-creating-data-with-a-simple-post)
   - [Step 6: Setting HTTP Status Codes & Errors (`wire.status` & `wire.abort`)](#step-6-setting-http-status-codes--errors-wirestatus--wireabort)
   - [Step 7: Updating (`patch` / `'put|patch'`) & Deleting (`delete`)](#step-7-updating-patch--putpatch--deleting-delete)
   - [Step 8: Returning HTML (`wire.html` & `wire.file`)](#step-8-returning-html-wirehtml--wirefile)
   - [Step 9: Assembled CRUD Server](#step-9-assembled-crud-server)
4. [Zero-Build Virtual ESM Client (`/@client.js`)](#4-zero-build-virtual-esm-client-clientjs)
   - [4.1 Step 1: Importing `api` in Browser or Frontend Apps](#41-step-1-importing-api-in-browser-or-frontend-apps)
   - [4.2 Step 2: Calling `GET`, `POST`, `PATCH`, `DELETE` & Typed Params](#42-step-2-calling-get-post-patch-delete--typed-params)
   - [4.3 Step 3: Consuming SSE Streams & WebSockets on the Client](#43-step-3-consuming-sse-streams--websockets-on-the-client)
5. [Static Routing, Redirects & Custom Error Pages](#5-static-routing-redirects--custom-error-pages)
   - [5.1 Static File & Folder Routing (`serveStatic` & `static`)](#51-static-file--folder-routing-servestatic--static)
   - [5.2 HTTP Redirects (`wire.redirect` & `redirect`)](#52-http-redirects-wireredirect--redirect)
   - [5.3 Custom Error Pages (`404`, `401`, `403`, `500`, etc.)](#53-custom-error-pages-404-401-403-500-etc)
6. [Server Configuration (`serve`)](#6-server-configuration-serve)
   - [6.1 All `serve()` Options](#61-all-serve-options)
   - [6.2 Server Instance Control (`port`, `url`, `fetch`, `close`)](#62-server-instance-control-port-url-fetch-close)
7. [Domain-Tree Projection & Routing](#7-domain-tree-projection--routing)
   - [7.1 Static, Dynamic, Typed, and Wildcard Segments](#71-static-dynamic-typed-and-wildcard-segments)
   - [7.2 Automatic Route Matching Priority](#72-automatic-route-matching-priority)
   - [7.3 Method Unions (`'put|patch'`) & Shorthand Leaf Functions](#73-method-unions-putpatch--shorthand-leaf-functions)
   - [7.4 Handler Argument Order](#74-handler-argument-order)
   - [7.5 Typed Route Parameters (`param`) — All Supported Types & Custom Formats](#75-typed-route-parameters-param--all-supported-types--custom-formats)
8. [Response Formatting, HTML & Streaming](#8-response-formatting-html--streaming)
   - [8.1 Automatic `Content-Type` Matrix](#81-automatic-content-type-matrix)
   - [8.2 HTML Responses & XSS Protection (`wire.html`)](#82-html-responses--xss-protection-wirehtml)
   - [8.3 File Streaming with `ETag` & Byte-Range (`wire.file`)](#83-file-streaming-with-etag--byte-range-wirefile)
   - [8.4 Server-Sent Events (SSE) with Async Generators](#84-server-sent-events-sse-with-async-generators)
   - [8.5 Sparse Fieldsets (`?fields=`) & Automatic Redaction (`redact`)](#85-sparse-fieldsets-fields--automatic-redaction-redact)
9. [Security, Sessions & Traffic Control](#9-security-sessions--traffic-control)
   - [9.1 Protecting Routes & Branches (`guard`)](#91-protecting-routes--branches-guard)
   - [9.2 Lazy Encrypted Sessions (`wire.session` & `wire.sessions`)](#92-lazy-encrypted-sessions-wiresession--wiresessions)
   - [9.3 Custom Session Store Interface (Redis / Database)](#93-custom-session-store-interface-redis--database)
   - [9.4 Timing-Safe Webhook Verification (`webhook`)](#94-timing-safe-webhook-verification-webhook)
   - [9.5 Rate Limiting (`limit` & `wire.cost`)](#95-rate-limiting-limit--wirecost)
   - [9.6 CORS & Preflight Handling (`origins`)](#96-cors--preflight-handling-origins)
10. [Caching, Validation & Resilience](#10-caching-validation--resilience)
    - [10.1 Self-Invalidating Response Cache (`cache`)](#101-self-invalidating-response-cache-cache)
    - [10.2 Request Coalescing (`coalesce`)](#102-request-coalescing-coalesce)
    - [10.3 Idempotent Mutations (`idempotent`)](#103-idempotent-mutations-idempotent)
    - [10.4 Declarative Input Validation (`expect`)](#104-declarative-input-validation-expect)
    - [10.5 Automatic Rollbacks (`wire.undo`) & Dry-Runs (`X-Simulate`)](#105-automatic-rollbacks-wireundo--dry-runs-x-simulate)
    - [10.6 Graceful Background Tasks (`wire.defer`)](#106-graceful-background-tasks-wiredefer)
    - [10.7 Load Shedding (`priority: 'low'`) & Deprecation (`sunset`)](#107-load-shedding-priority-low--deprecation-sunset)
11. [Linear WebSockets & Pub/Sub](#11-linear-websockets--pubsub)
    - [11.1 Step 1: Minimal Echo WebSocket (`ws` & `for await`)](#111-step-1-minimal-echo-websocket-ws--for-await)
    - [11.2 Step 2: Rooms & Pub/Sub Broadcasting (`socket.join`, `wire.publish`)](#112-step-2-rooms--pubsub-broadcasting-socketjoin-wirepublish)
    - [11.3 Step 3: Guarded WebSockets & `wsConfig`](#113-step-3-guarded-websockets--wsconfig)
12. [Streaming File Uploads (`wire.multipart` & `rawBody`)](#12-streaming-file-uploads-wiremultipart--rawbody)
13. [Decoupled Side Effects (`reactTo`)](#13-decoupled-side-effects-reactto)
14. [Logging, Debugging & Automated Testing](#14-logging-debugging--automated-testing)
    - [14.1 Startup Messages & Access Logs (`message`, `onListen`, `accessLog`)](#141-startup-messages--access-logs-message-onlisten-accesslog)
    - [14.2 Error-Triggered Debug Trace (`wire.log.debug`) & `Server-Timing` (`wire.mark`)](#142-error-triggered-debug-trace-wirelogdebug--server-timing-wiremark)
    - [14.3 Automated Test Synthesis (`synthesizeTests`)](#143-automated-test-synthesis-synthesizetests)
    - [14.4 Error Snapshots & Local Replay (`snapshotOnError` & `replay`)](#144-error-snapshots--local-replay-snapshotonerror--replay)
15. [Complete Ambient `wire` API Reference](#15-complete-ambient-wire-api-reference)
16. [License](#16-license)

---

## 1. Why servin?

Conventional Node.js frameworks require you to bind handlers to string URLs, chain `(req, res, next)` middleware, manually parse and validate route parameters, and maintain separate client-side `fetch()` wrappers alongside separate WebSocket and cache-invalidation systems.

`servin` replaces that boilerplate with two core concepts:

1. **Domain-Tree Projection:** You structure your backend as a plain nested JavaScript object. `servin` projects that tree directly onto HTTP endpoints, static assets, SSE streams, WebSockets, and a browser-ready ES module (`/@client.js`).
2. **Ambient `wire`:** Powered by Node.js `AsyncLocalStorage`, `wire` lets any function read headers, set status codes, issue redirects, manage sessions, register rollbacks, or publish WebSocket messages without passing `req` or `res` arguments down the call stack.

---

## 2. Requirements & Installation

- **Runtime:** Node.js `v20.0.0` or higher.
- **Dependencies:** Zero external dependencies.
- **Module Format:** ES Modules (`"type": "module"` in `package.json`).

Install `servin`:

```bash
npm install servin
```

Verify your `package.json` includes `"type": "module"`:

```json
{
  "name": "my-servin-app",
  "type": "module",
  "scripts": {
    "start": "node server.js"
  }
}
```

---

## 3. Step-by-Step Core Walkthrough

### Step 1: Starting the Server (`serve`)

Create `server.js` and call `serve()`. By default, it listens on `127.0.0.1:3000`:

```javascript
import { serve } from "servin";

await serve({
  port: 3000,
  api: {},
});
```

You can customize the startup log message using `message`:

```javascript
import { serve } from "servin";

await serve({
  port: 3000,
  message: ({ port }) => `Server is running on port ${port}`,
  api: {},
});
```

### Step 2: How URL Routing Works & Your First `GET`

In `servin`, **you never write URL path strings**. Every object key inside `api` becomes a URL segment, and a lowercase HTTP verb (`get`, `post`, `put`, `patch`, `delete`) defines the handler:

```text
Object Tree                              HTTP Endpoint
───────────────────────────────────────────────────────────────
api: {
  hello: {
    get() { ... }            ──────►     GET /hello
  },
  tasks: {
    get() { ... }            ──────►     GET /tasks
  }
}
```

Any plain object or array you `return` is automatically serialized as `application/json` (`200 OK`):

```javascript
import { serve } from "servin";

const tasksDb = [
  { id: 1, title: "Learn servin", done: true },
  { id: 2, title: "Build an API", done: false },
];

await serve({
  port: 3000,
  api: {
    // GET /hello
    hello: {
      get: () => ({ message: "Hello from servin!" }),
    },

    // GET /tasks
    tasks: {
      get: () => tasksDb,
    },
  },
});
```

### Step 3: Reading URL Query Parameters (`?done=true`)

Every `get()` handler automatically receives a `query` object containing the URL search parameters:

```javascript
const tasks = {
  // GET /tasks?done=false
  get(query) {
    if (query.done === "true") {
      return tasksDb.filter((t) => t.done);
    }
    if (query.done === "false") {
      return tasksDb.filter((t) => !t.done);
    }
    return tasksDb;
  },
};
```

### Step 4: Dynamic URL Segments (`$id`) & Type Rules (`param`)

Prefix a key with `$` to capture a dynamic URL segment:

```javascript
// Matches ANY string: /tasks/1, /tasks/abc, /tasks/hello
const tasks = {
  $id: {
    get(id) {
      return { rawId: id }; // `id` is always a string when untyped
    },
  },
};
```

To restrict a parameter to a specific type or pattern while keeping object keys as clean JavaScript identifiers, wrap the branch in **`param(rule, branch)`**. `param()` supports built-in types (`'int'`, `'number'`, `'float'`, `'bigint'`, `'uuid'`, `'alpha'`, `'alnum'`, `'slug'`, `'bool'`, `'boolean'`, `'string'`), native constructors (`Number`, `Boolean`, `BigInt`, `String`), regular expressions (`/^[A-Z]{3}-\d+$/`), custom functions, and named custom types from `serve({ types })`.

```javascript
import { param } from "servin";

const tasks = {
  // GET /tasks/1   -> matches! `id` is coerced to number `1`
  // GET /tasks/abc -> automatically rejected with 404 Not Found
  $id: param("int", {
    get(id) {
      return tasksDb.find((t) => t.id === id);
    },
  }),
};
```

See [Section 7.5](#75-typed-route-parameters-param--all-supported-types--custom-formats) for every supported type and custom format option.

### Direct Path Parameters on Route Nodes (`wire.params` & `wire.param(name)`)

Read trailing path segments directly inside a route handler without creating a separate `$id` child branch.

- `GET /profile?id=234` reads query parameters via `wire.url.searchParams.get('id')`.
- `GET /profile/234` reads the trailing path segment directly via `wire.params.id` or `wire.param('id')`.

````javascript
import { serve, wire } from './index.js';

await serve({
  port: 3000,
  api: {
    profile: {
      get() {
        const id = wire.param('id'); // or wire.params.id
        const queryId = wire.url.searchParams.get('id');
        return { id, queryId };
      }
    }
  }
});

### Step 5: Creating Data with a Simple `POST`

Add a `post(payload)` method to handle `POST /tasks`. `servin` automatically parses the incoming JSON body and passes it as `payload`:

```javascript
let nextId = 3;

const tasks = {
  get: () => tasksDb,

  // POST /tasks
  post(payload) {
    const newTask = {
      id: nextId++,
      title: payload.title,
      done: false,
    };
    tasksDb.push(newTask);
    return newTask;
  },
};
````

### Step 6: Setting HTTP Status Codes & Errors (`wire.status` & `wire.abort`)

Import `wire` when you need to change the HTTP status code or stop a request with an error:

- `wire.status(201)` sets the response status to `201 Created`.
- `wire.abort(404, 'Message')` immediately stops execution and returns `{ "error": "Message" }` with status `404`.

```javascript
import { wire, param } from "servin";

const tasks = {
  post(payload) {
    const newTask = { id: nextId++, title: payload.title, done: false };
    tasksDb.push(newTask);

    wire.status(201); // Return 201 Created instead of 200
    return newTask;
  },

  $id: param("int", {
    get(id) {
      const task = tasksDb.find((t) => t.id === id);
      if (!task) wire.abort(404, `Task #${id} not found`);
      return task;
    },
  }),
};
```

### Step 7: Updating (`patch` / `'put|patch'`) & Deleting (`delete`)

Add `patch` (or `'put|patch'` to handle both verbs in one function) and `delete` inside `$id`:

```javascript
const taskById = param("int", {
  get(id) {
    const task = tasksDb.find((t) => t.id === id);
    if (!task) wire.abort(404, `Task #${id} not found`);
    return task;
  },

  // PATCH /tasks/:id
  patch(id, payload) {
    const task = tasksDb.find((t) => t.id === id);
    if (!task) wire.abort(404, `Task #${id} not found`);
    Object.assign(task, payload);
    return task;
  },

  // DELETE /tasks/:id
  delete(id) {
    const idx = tasksDb.findIndex((t) => t.id === id);
    if (idx === -1) wire.abort(404, `Task #${id} not found`);
    tasksDb.splice(idx, 1);
    wire.status(204);
    return null; // Sends empty 204 No Content
  },
});
```

### Step 8: Returning HTML (`wire.html` & `wire.file`)

By default, returning a plain `string` sends `text/plain` so user text cannot accidentally execute scripts. To serve HTML:

**Option A — Inline HTML string with `wire.html`:**

```javascript
const home = {
  get: () => wire.html("<h1>Welcome to Task Manager</h1>"),
};
```

**Option B — Tagged template ``wire.html`...` `` (auto-escapes variables against XSS):**

```javascript
const greet = {
  $name: {
    get(name) {
      return wire.html`<h1>Hello, ${name}!</h1>`;
    },
  },
};
```

**Option C — Streaming an HTML file from disk with `wire.file`:**

```javascript
const about = {
  get: () => wire.file("./pages/about.html"),
};
```

### Step 9: Assembled CRUD Server

Combining Steps 1–8 gives you a complete, readable CRUD server:

```javascript
import { serve, wire, param } from "servin";

const tasksDb = [
  { id: 1, title: "Learn servin", done: true },
  { id: 2, title: "Build an API", done: false },
];
let nextId = 3;

const tasks = {
  get(query) {
    if (query.done === "true") return tasksDb.filter((t) => t.done);
    if (query.done === "false") return tasksDb.filter((t) => !t.done);
    return tasksDb;
  },

  post(payload) {
    const newTask = { id: nextId++, title: payload.title, done: false };
    tasksDb.push(newTask);
    wire.status(201);
    return newTask;
  },

  $id: param("int", {
    get(id) {
      const task = tasksDb.find((t) => t.id === id);
      if (!task) wire.abort(404, `Task #${id} not found`);
      return task;
    },

    patch(id, payload) {
      const task = tasksDb.find((t) => t.id === id);
      if (!task) wire.abort(404, `Task #${id} not found`);
      Object.assign(task, payload);
      return task;
    },

    delete(id) {
      const idx = tasksDb.findIndex((t) => t.id === id);
      if (idx === -1) wire.abort(404, `Task #${id} not found`);
      tasksDb.splice(idx, 1);
      wire.status(204);
      return null;
    },
  }),
};

await serve({
  port: 3000,
  message: ({ port }) => `Server is running on port ${port}`,
  api: {
    home: { get: () => wire.html("<h1>Task Manager</h1>") },
    tasks,
  },
});
```

---

## 4. Zero-Build Virtual ESM Client (`/@client.js`)

Because `servin` compiles your `api` tree at startup, it automatically serves **`GET /@client.js`**—a lightweight, zero-dependency ES module that mirrors your exact backend domain structure.

Frontend code (vanilla HTML `<script type="module">`, React, Vue, Svelte, or Vite) can import `api` directly from `/@client.js` **without writing `fetch()`, URL strings, JSON serialization, or build-step code generators**.

### 4.1 Step 1: Importing `api` in Browser or Frontend Apps

**Same-origin HTML page served by `servin`:**

```html
<!doctype html>
<html>
  <body>
    <ul id="list"></ul>

    <script type="module">
      import { api } from "/@client.js";

      const tasks = await api.tasks.get();
      document.getElementById("list").innerHTML = tasks
        .map((t) => `<li>${t.title}</li>`)
        .join("");
    </script>
  </body>
</html>
```

**Separate frontend dev server (e.g., Vite on `:5173` calling `servin` on `:3000`):**

```javascript
import { api } from "http://localhost:3000/@client.js";

const tasks = await api.tasks.get();

// GET with custom header
const profile = await api.profile.get(authHeaders);

// GET with query + header
const orders = await api.v1.orders.get({ page: 1 }, authHeaders);

// POST with body + header
const created = await api.v1.orders.post(
  { item: "Keyboard", qty: 2 },
  authHeaders,
);
```

### 4.2 Step 2: Calling `GET`, `POST`, `PATCH`, `DELETE` & Typed Params

Every method call on `api` matches the exact shape of your server's `api` tree and automatically includes credentials (`HttpOnly` session cookies) and JSON headers:

```javascript
import { api } from "/@client.js";

// 1. GET /tasks?done=false
const pending = await api.tasks.get({ done: "false" });

// 2. POST /tasks
const created = await api.tasks.post({ title: "Ship v1.0" });

// 3. GET /tasks/1 (passes `1` into `$id`)
const single = await api.tasks.$id.get(1);

// 4. PATCH /tasks/1 (first arg is `$id`, second arg is JSON body)
const updated = await api.tasks.$id.patch(1, { done: true });

// 5. DELETE /tasks/1 (returns `null` on 204 No Content)
await api.tasks.$id.delete(1);
```

### 4.3 Step 3: Consuming SSE Streams

`/@client.js` also translates Server-Sent Events and WebSockets into standard JavaScript `for await...of` async iterators:

```javascript
import { api } from "/@client.js";

// 1. Consuming an SSE endpoint (async *get())
for await (const tick of api.clock.get()) {
  console.log("Server tick:", tick);
}
```

---

# Servin WebSocket Guide

`servin` provides a declarative, integrated directly into your domain routing tree (`api.<route>.ws`) and virtual ESM client (`/@client.js`). It is designed to work cleanly alongside standard HTTP routes, sessions, and route guards while supporting per-socket state, rooms, targeted socket filtering, payload/rate/backpressure guards, action validation, optional room state with sequence tracking (`seq`), ring-buffer replay on reconnect, and explicit client sync/refresh/resync controls.

## Feature Overview & Scope

### Included in the Final WebSocket API

- **Declarative `open`, `actions`, and `close` blocks:** Separates connection lifecycle hooks from named client-callable actions.

- **Per-socket context (`socket.state`):** Mutable state attached to a single socket instance across `open`, `actions`, and `close`.

- **Direct connection data (`api.<route>.ws({ ... })`):** Passes initial connection data directly as an object without wrapping it in `{ query: { ... } }`, mapped automatically to the WebSocket upgrade URL.

- **Built-in rooms & broadcasting (`join`, `leave`, `to(room).broadcast(...)`):** Groups sockets into channels and broadcasts events with optional exclusions (such as `except: socket`).

- **Targeted socket filtering (`sockets.where(predicate).send(...)`):** Filters active sockets dynamically by predicate and sends targeted messages without manual loops or room-wide broadcasts.

- **Guards & action validation:** Enforces payload size limits (`maxPayloadBytes`), inbound message rate limits (`maxEventsPerSec`), outbound backpressure limits (`maxBufferedBytes`), and per-action `validate` hooks.

- **Optional room state & `commit`:** Maintains shared state per room when `state(socket, req)` is defined, incrementing a monotonic `seq` counter on every `commit` and storing entries in a bounded ring buffer.

- **Automatic sequence sync, ring-buffer replay & snapshot fallback:** Tracks mutation sequence numbers, replays missed patches upon reconnect via `__lastSeq`, and falls back to a full snapshot when `__lastSeq` falls outside the ring buffer window.

- **Standalone client `.sync(callback)`:** Delivers synchronized state and metadata to user-managed client code without coupling the framework to DOM elements or rendering libraries.

- **Connection & sync controls (`ws.refresh(...)` and `ws.resync(...)`):** `ws.refresh(nextData)` closes and reopens the connection (optionally updating connection data), while `ws.resync(room)` requests a fresh full snapshot without closing the active socket.

## Guide

### Step 1: Basic Connection (`open`, `actions`, `close`, `.on()`, and `.emit()`)

Start with a minimal WebSocket endpoint on a route node (for example, `api.chat.ws`) and connect from the browser using `api.chat.ws()`.

#### Server

```
import { serve } from './server.js';

await serve({
  port: 3000,
  api: {
    chat: {
      ws: {
        //handle when client connect
        open(socket) {
          socket.send({ event: 'welcome', message: 'Connected to chat' });
        },
        //list all events
        actions: {
          //each event
          ping(payload, socket) {
            //send back to the client
            socket.send({
              event: 'pong',
              payload: data,
              sentAt: payload?.sentAt ?? null,
              serverTime: Date.now()
            });
          }
        },
        close() {
          // Clean up any non-room resources tied to this connection
        }
      }
    }
  }
});

```

#### Client (`/@client.js`)

```
import { api } from '/@client.js';

const ws = api.chat.ws();

ws
  .on('open', ({ reconnected }) => {
    console.log(reconnected ? 'Reconnected to chat' : 'Connected to chat');
    //emit an event
    ws.emit('ping', { data:"hello" });
  })
  .on('event', (data) => {
    console.log('Received from server:', data);
  })
  .on('close', ({ code, reason, manual }) => {
    console.log('Socket closed:', { code, reason, manual });
  });

```

#### How It Works

- Defining `ws` as an object inside an API node compiles a route with verb `WS` at that node's path (`/chat`).

- On the client, `ws.emit(actionName, payload)` serializes `{ type: 'action', name, payload }` and dispatches the matching handler in `actions`.

- Server-sent targeted events (`socket.send(...)`) arrive on the client under the `'event'` listener.

### Step 2: Direct Connection Data & Per-Socket State (`socket.state`)

Pass initial connection data directly to `api.<route>.ws({ ... })` without a `{ query: { ... } }` wrapper. On the server, read those values from `req.data` and store connection-specific properties on `socket.state`.

#### Server

```
api: {
  presence: {
    ws: {
      open(socket, req) {
        socket.state = {
          userId: req.data.userId || 'anonymous',
          role: req.data.role || 'member',
          room: req.data.room || 'lobby'
        };

        socket.join(socket.state.room);
        socket.send({
          event: 'session_ready',
          state: socket.state
        });
      },

      actions: {
        updateRole(payload, socket) {
          if (!payload?.role) return;
          socket.state.role = String(payload.role);
          socket.send({
            event: 'role_updated',
            role: socket.state.role
          });
        }
      },

      close(socket) {
        if (socket.state?.room) {
          socket.leave(socket.state.room);
        }
      }
    }
  }
}

```

#### Client

```
import { api } from '/@client.js';

const ws = api.presence.ws({
  userId: 'usr_42',
  role: 'member',
  room: 'lobby'
});

ws
  .on('open', () => {
    ws.emit('updateRole', { role: 'editor' });
  })
  .on('event', (msg) => {
    console.log('Presence event:', msg);
  });

```

#### How It Works

- `api.presence.ws({ userId: 'usr_42', room: 'lobby' })` encodes top-level keys directly onto the WebSocket handshake URL query string.

- `req.data` exposes those connection parameters (excluding internal `__lastSeq`) cleanly in `open` and `state`.

- `socket.state` is a plain object scoped to a single socket connection, making it safe for per-user attributes like `userId`, `role`, or active `room`.

### Step 3: Rooms & Broadcasting (`join`, `leave`, `to(room).broadcast`)

Group sockets into rooms using `socket.join(room)` and `socket.leave(room)`, and publish updates to room members via `socket.to(room).broadcast(data, options)`.

#### Server

```
api: {
  rooms: {
    ws: {
      open(socket, req) {
        const room = req.data.room || 'general';
        const user = req.data.user || 'guest';

        socket.state = { room, user };
        socket.join(room);

        socket.to(room).broadcast(
          { data:here },
          { except: socket } //if you need to excluded
        );
      },

      actions: {
        switchRoom(payload, socket) {
          const nextRoom = String(payload?.room || '').trim();
          if (!nextRoom) return;

          const prevRoom = socket.state.room;
          if (prevRoom) {
            socket.leave(prevRoom);
            socket.to(prevRoom).broadcast(
              { type: 'member_left', user: socket.state.user, to: nextRoom },
              { except: socket }
            );
          }

          socket.state.room = nextRoom;
          socket.join(nextRoom);
          socket.to(nextRoom).broadcast(
            { type: 'member_joined', user: socket.state.user, from: prevRoom },
            { except: socket }
          );
        },

        say(payload, socket) {
          const { room, user } = socket.state;
          if (!room) return;

          socket.to(room).broadcast(
            { type: 'message', from: user, text: String(payload?.text ?? '') },
            { except: socket }
          );
        }
      },

      close(socket) {
        const { room, user } = socket.state || {};
        if (room) {
          socket.leave(room);
          socket.to(room).broadcast(
            { type: 'member_left', user },
            { except: socket }
          );
        }
      }
    }
  }
}

```

#### Client

```
import { api } from '/@client.js';

const ws = api.rooms.ws({ room: 'general', user: 'maya' });

ws
  .on('broadcast', ({ room, payload }) => {
    console.log(`[${room}]`, payload);
  })
  .on('open', () => {
    ws.emit('say', { text: 'Hello room!' });
    ws.emit('switchRoom', { room: 'engineering' });
  });

```

#### How It Works

- `socket.to(room).broadcast(data, { except })` sends a `'broadcast'` envelope `{ type: 'broadcast', room, payload }` to open sockets subscribed to `room`.

- Passing `{ except: socket }` prevents echoing a peer's own action back to the sender. By default, `except` excludes the acting `socket`.

- Always call `socket.leave(room)` when switching rooms or in `close` so room memberships stay accurate.

### Step 4: Targeted Socket Filtering (`sockets.where(...)`)

When you need to reach a subset of active connections based on dynamic attributes (such as role, workspace, or tenant) rather than an entire room, use `sockets.where(predicate).send(data)` from the action helpers object.

#### Server

```
api: {
  support: {
    ws: {
      open(socket, req) {
        socket.state = {
          userId: req.data.userId || 'guest',
          role: req.data.role || 'customer',
          tier: req.data.tier || 'standard'
        };
      },

      actions: {
        escalate(payload, socket, { sockets }) {
          const target = sockets.where(
            (peer) =>
              peer !== socket &&
              peer.state?.role === 'agent' &&
              peer.state?.tier === 'enterprise'
          );

          target.send({
            type: 'escalation',
            from: socket.state.userId,
            issue: String(payload?.issue ?? '')
          });

          socket.send({
            type: 'escalation_ack',
            notifiedAgents: target.count
          });
        }
      }
    }
  }
}

```

#### Client

```
import { api } from '/@client.js';

const ws = api.support.ws({
  userId: 'cust_99',
  role: 'customer',
  tier: 'enterprise'
});

ws
  .on('event', (msg) => {
    if (msg.type === 'escalation_ack') {
      console.log(`Notified ${msg.notifiedAgents} enterprise agents`);
    }
    if (msg.type === 'escalation') {
      console.log('Incoming escalation:', msg);
    }
  })
  .on('open', () => {
    ws.emit('escalate', { issue: 'Production webhook timeout' });
  });

```

#### How It Works

- `sockets.where(predicate)` evaluates `predicate(peerSocket)` across active sockets and returns `{ sockets, count, send(data) }`.

- Calling `.send(data)` delivers `{ type: 'event', payload: data }` to every matched socket.

- Because `socket.state` is checked inside the predicate, filtering reflects live state changes made during the session.

### Step 5: Guards, Backpressure & Action Validation

Protect your endpoint against oversized frames, message floods, slow consumers, and malformed action payloads using route-level guard options and action `{ validate, run }` definitions.

#### Server

```
api: {
  tasks: {
    ws: {
      maxPayloadBytes: 16384,     // Reject incoming frames larger than 16 KB
      maxEventsPerSec: 20,        // Cap inbound messages per socket per second
      maxBufferedBytes: 131072,   // Close slow sockets exceeding 128 KB outbound buffer

      open(socket, req) {
        socket.state = {
          room: req.data.room || 'sprint-1',
          actor: req.data.actor || 'member'
        };
        socket.join(socket.state.room);
      },

      actions: {
        addTask: {
          validate(payload) {
            const title = String(payload?.title ?? '').trim();
            if (!title) {
              throw new Error('VALIDATION_TITLE_REQUIRED');
            }
            if (title.length > 120) {
              throw new Error('VALIDATION_TITLE_TOO_LONG');
            }
            return { title };
          },

          run(cleanPayload, socket, { commit }) {
            const { room, actor } = socket.state;
            commit(room, { op: 'add_task', actor }, (draft) => {
              draft.tasks = draft.tasks || [];
              draft.tasks.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                title: cleanPayload.title,
                completed: false
              });
            });
          }
        }
      }
    }
  }
}

```

#### Client

```
import { api } from '/@client.js';

const ws = api.tasks.ws({ room: 'sprint-1', actor: 'alex' });

ws
  .on('error', (err) => {
    console.error('Server rejected request:', err);
  })
  .on('open', () => {
    // Triggers validation error -> sent back via 'error' event
    ws.emit('addTask', { title: '   ' });

    // Passes validation -> mutates room state via commit
    ws.emit('addTask', { title: 'Ship WebSocket guide' });
  });

```

#### How It Works

- `maxPayloadBytes` checks incoming WebSocket frame payload length before parsing.

- `maxEventsPerSec` tracks a 1-second window per socket and emits `{ type: 'error', message: 'RATE_LIMIT_EXCEEDED' }` when exceeded.

- `maxBufferedBytes` monitors `socket.bufferedAmount` (`tcpSocket.writableLength`) before writing outbound frames, closing sockets that fall too far behind.

- When an action is defined as `{ validate, run }`, `validate` runs first; if it throws, `run` is skipped and `{ type: 'error', action, message }` is sent back to the caller socket.

### Step 6: Room State, `commit`, `seq`, Ring Buffer Replay & `.sync(...)`

Add a `state(socket, req)` hook to enable room-level synchronized state. Every `commit(room, meta, mutator)` mutates the room state in place, increments `seq`, records the update in a bounded ring buffer (`sync.bufferSize`), and pushes state updates to room subscribers.

#### Server

```
api: {
  board: {
    ws: {
      sync: {
        bufferSize: 100
      },

      state(socket, req) {
        const room = req.data.room || 'default-board';
        return {
          room,
          items: []
        };
      },

      open(socket, req) {
        const room = req.data.room || 'default-board';
        socket.state = {
          room,
          user: req.data.user || 'guest'
        };
        if (!socket.rooms.has(room)) {
          socket.join(room);
        }
      },

      actions: {
        toggleItem: {
          validate(payload) {
            const id = String(payload?.id ?? '').trim();
            if (!id) throw new Error('ITEM_ID_REQUIRED');
            return { id };
          },
          run({ id }, socket, { commit }) {
            const { room, user } = socket.state;
            commit(room, { op: 'toggle_item', by: user, id }, (draft) => {
              const item = draft.items.find((entry) => entry.id === id);
              if (item) {
                item.done = !item.done;
              }
            });
          }
        },

        createItem: {
          validate(payload) {
            const label = String(payload?.label ?? '').trim();
            if (!label) throw new Error('LABEL_REQUIRED');
            return { label };
          },
          run({ label }, socket, { commit }) {
            const { room, user } = socket.state;
            commit(room, { op: 'create_item', by: user }, (draft) => {
              draft.items.push({
                id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                label,
                done: false
              });
            });
          }
        }
      }
    }
  }
}

```

#### Client

```
import { api } from '/@client.js';

let latestBoardState = null;

const ws = api.board.ws({
  room: 'default-board',
  user: 'maya'
});

ws.sync((state, meta) => {
  // Store and render state in your own application layer
  latestBoardState = state;
  console.log('State synced:', {
    seq: meta.seq,
    room: meta.room,
    fullSnapshot: meta.fullSnapshot,
    replayed: meta.replayed,
    meta: meta.meta ?? null
  });
  renderBoardView(latestBoardState);
});

```

#### How It Works

- On initial connection (when `__lastSeq` is `0`), the server sends a `sync_snapshot` (`fullSnapshot: true, replayed: false`) with the current `seq` and `state`.

- On `commit`, the server increments `seq`, pushes `{ seq, meta, state }` into the room's ring buffer, and sends `sync_patch` (`fullSnapshot: false, replayed: false`) to members of that room.

- On automatic reconnect, the client appends `__lastSeq=<lastSeq>` to the WebSocket URL:
  - If `lastSeq` is within the ring buffer range, missed entries are replayed in order with `replayed: true`.

  - If `lastSeq` is too old or outside the ring buffer range, the server falls back to sending a `sync_snapshot` (`fullSnapshot: true`).

- `.sync(callback)` is standalone: if a snapshot has already arrived when `.sync` is attached, `callback` is immediately invoked with the current state so late subscribers stay up to date.

### Step 7: Refreshing Connections & Manual Resync (`ws.refresh(...)` & `ws.resync(...)`)

Use `ws.refresh(nextData)` when you want to close and reopen the socket—such as moving to another room or changing connection parameters—and `ws.resync(room)` when you want a fresh snapshot without closing the active connection.

#### Client

```
import { api } from '/@client.js';

const ws = api.board.ws({
  room: 'sprint-1',
  user: 'maya'
});

ws.sync((state, meta) => {
  console.log(`Room ${meta.room} @ seq ${meta.seq}`, state);
});

// Close and reopen the connection with updated connection data (no { query: ... } wrapper)
function moveToSprint(nextRoom) {
  ws.refresh({ room: nextRoom });
}

// Request a full state snapshot while keeping the current WebSocket open
function requestFreshSnapshot() {
  ws.resync('sprint-2');
}

```

#### How It Works

- `ws.refresh(nextData)` merges any provided `nextData` object into the connection data, resets `lastSeq` to `0`, closes the existing socket cleanly, and opens a new connection with the updated URL.

- `ws.resync(room)` sends `{ type: 'resync', room }` over the open socket, prompting the server to send a `sync_snapshot` for the target room.

### Step 8: Complete End-to-End Example

Below is a complete, self-contained example combining direct connection data, `socket.state`, rooms & `broadcast`, `sockets.where(...)`, guards & `validate`, room state + `commit` + `seq` replay, `.sync(...)`, `.refresh(...)`, and `.resync(...)`.

#### Server (`server.js` entry)

```
import { serve } from './server.js';

await serve({
  port: 3000,
  api: {
    workspace: {
      ws: {
        maxPayloadBytes: 32768,
        maxEventsPerSec: 25,
        maxBufferedBytes: 262144,
        sync: {
          bufferSize: 100
        },

        state(socket, req) {
          const room = req.data.room || 'general';
          return {
            room,
            notes: []
          };
        },

        open(socket, req) {
          const room = req.data.room || 'general';
          const user = req.data.user || 'guest';
          const role = req.data.role || 'member';

          socket.state = { room, user, role };
          if (!socket.rooms.has(room)) {
            socket.join(room);
          }

          socket.to(room).broadcast(
            { event: 'presence', status: 'online', user },
            { except: socket }
          );
        },

        actions: {
          addNote: {
            validate(payload) {
              const text = String(payload?.text ?? '').trim();
              if (!text) throw new Error('NOTE_TEXT_REQUIRED');
              return { text };
            },
            run({ text }, socket, { commit }) {
              const { room, user } = socket.state;
              commit(room, { op: 'add_note', author: user }, (draft) => {
                draft.notes.push({
                  id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  author: user,
                  text
                });
              });
            }
          },

          removeNote: {
            validate(payload) {
              const id = String(payload?.id ?? '').trim();
              if (!id) throw new Error('NOTE_ID_REQUIRED');
              return { id };
            },
            run({ id }, socket, { commit }) {
              const { room, user } = socket.state;
              commit(room, { op: 'remove_note', actor: user, id }, (draft) => {
                draft.notes = draft.notes.filter((note) => note.id !== id);
              });
            }
          },

          pingRole: {
            validate(payload) {
              const role = String(payload?.role ?? '').trim();
              if (!role) throw new Error('TARGET_ROLE_REQUIRED');
              return {
                role,
                message: String(payload?.message ?? '')
              };
            },
            run({ role, message }, socket, { sockets }) {
              sockets
                .where((peer) => peer !== socket && peer.state?.role === role)
                .send({
                  event: 'role_ping',
                  from: socket.state.user,
                  message
                });
            }
          }
        },

        close(socket) {
          const { room, user } = socket.state || {};
          if (room) {
            socket.leave(room);
            socket.to(room).broadcast(
              { event: 'presence', status: 'offline', user },
              { except: socket }
            );
          }
        }
      }
    }
  }
});

```

#### Client (`client.js`)

```
import { api } from '/@client.js';

let workspaceState = null;

const ws = api.workspace.ws({
  room: 'general',
  user: 'maya',
  role: 'lead'
});

ws
  .on('open', ({ reconnected }) => {
    console.log(reconnected ? 'Reconnected to workspace' : 'Connected to workspace');
  })
  .on('broadcast', ({ room, payload }) => {
    console.log(`Broadcast in ${room}:`, payload);
  })
  .on('event', (payload) => {
    console.log('Targeted event:', payload);
  })
  .on('error', (err) => {
    console.error('WS error:', err);
  })
  .sync((state, meta) => {
    workspaceState = state;
    console.log('Synced state:', {
      seq: meta.seq,
      room: meta.room,
      fullSnapshot: meta.fullSnapshot,
      replayed: meta.replayed,
      notesCount: workspaceState?.notes?.length ?? 0
    });
  });

// Add a note to the current room state
ws.emit('addNote', { text: 'Kickoff sync notes' });

// Send a targeted message only to other connected sockets with role 'lead'
ws.emit('pingRole', { role: 'lead', message: 'Check latest notes' });

// Switch room with a fresh connection and updated connection data
ws.refresh({ room: 'planning' });

// Request a full snapshot without closing the connection
ws.resync('planning');

```

---

## 5. Static Routing, Redirects & Custom Error Pages

### 5.1 Static File & Folder Routing (`serveStatic` & `static`)

`servin` serves static files and entire directories with automatic MIME detection, `ETag` (`304 Not Modified`), `Byte-Range` streaming (`206 Partial Content`), directory `index.html` resolution, and built-in path-traversal protection.

**Step 1 — Mount static folders or single files via `serve({ static })`:**

```javascript
import { serve } from "servin";

await serve({
  port: 3000,
  static: {
    "/assets": "./public/assets", // Serves entire directory at /assets/*
    "/favicon.ico": "./public/favicon.ico", // Serves a single file at /favicon.ico
  },
  api: {
    health: { get: () => ({ ok: true }) },
  },
});
```

**Step 2 — Mount static directories inside the `api` tree with `serveStatic()` (and combine with `guard()`):**

```javascript
import { serve, guard, serveStatic } from "servin";

await serve({
  port: 3000,
  api: {
    // Public documentation folder with Cache-Control header
    docs: serveStatic("./public/docs", {
      index: "index.html",
      cacheControl: "public, max-age=3600",
    }),

    // Protected downloads folder requiring login
    downloads: guard(
      requireAuth,
      serveStatic("./storage/private", {
        dotfiles: "deny", // Returns 403 Forbidden for .env, .git, etc.
      }),
    ),
  },
});
```

**Step 3 — Single-Page Application (SPA) fallback mode:**

Set `spa: true` so client-side routes (like `/app/settings/profile`) automatically fall back to `index.html` when no matching asset file exists:

```javascript
const api = {
  app: serveStatic("./dist", {
    spa: true,
    index: "index.html",
  }),
};
```

**All `serveStatic(targetPath, options)` options:**

| Option         | Type                            | Default        | Description                                                                               |
| :------------- | :------------------------------ | :------------- | :---------------------------------------------------------------------------------------- |
| `index`        | `string \| false`               | `'index.html'` | Default file served when a directory URL is requested. Set `false` to disable.            |
| `dotfiles`     | `'ignore' \| 'deny' \| 'allow'` | `'ignore'`     | How files/folders starting with `.` (e.g., `.env`) are handled (`404`, `403`, or served). |
| `cacheControl` | `string \| null`                | `null`         | Optional `Cache-Control` response header (e.g., `'public, max-age=86400'`).               |
| `spa`          | `boolean`                       | `false`        | Falls back to `index` (or `fallback`) when a requested sub-path is not found.             |
| `fallback`     | `string \| null`                | `null`         | Custom fallback HTML file path when `spa: true` is enabled.                               |

### 5.2 HTTP Redirects (`wire.redirect` & `redirect`)

**1. Declarative redirects in the `api` tree (`redirect(target, status = 301)`):**

```javascript
import { serve, param, redirect } from "servin";

await serve({
  port: 3000,
  api: {
    // Static permanent redirect: GET /old-blog -> 301 Location: /articles
    "old-blog": redirect("/articles", 301),

    // Dynamic redirect using extracted route parameters & query:
    promo: {
      $code: param(
        "alnum",
        redirect((code, query) => {
          const ref = query.ref ? `&ref=${encodeURIComponent(query.ref)}` : "";
          return `/checkout?voucher=${code}${ref}`;
        }, 302),
      ),
    },
  },
});
```

**2. Imperative redirects inside handlers (`wire.redirect(location, status = 302)`):**

Calling `wire.redirect()` immediately halts handler execution, **commits any newly created/updated `wire.session` cookies**, and sends the redirect response:

```javascript
const auth = {
  login: {
    async post({ email }) {
      await wire.session.rotate();
      wire.session.user = email;

      // Session cookie is automatically attached to this 302 redirect response
      wire.redirect("/dashboard");
    },
  },
};
```

### 5.3 Custom Error Pages (`404`, `401`, `403`, `500`, etc.)

Configure `errors` in `serve()` to customize responses for specific HTTP status codes (`404`, `401`, `403`, `405`, `422`, `429`, `500`), status ranges (`'4xx'`, `'5xx'`), or `default`.

An error handler can return **`wire.html`**, **`wire.file()`**, a **JSON object**, a **plain string**, or trigger **`wire.redirect()`**:

```javascript
import { serve, wire, guard } from "servin";

const requireAdmin = () => {
  if (!wire.session.user) wire.abort(401, "Authentication required");
  if (wire.session.role !== "admin")
    wire.abort(403, "Administrator access required");
};

await serve({
  port: 3000,
  session: { secret: "replace-with-32-char-secret-key!!" },

  errors: {
    // 1. Custom 404 Not Found HTML page
    404({ path }) {
      return wire.html`
        <h1>404 — Page Not Found</h1>
        <p>No route matches <code>${path}</code>.</p>
        <a href="/">Back to Home</a>
      `;
    },

    // 2. Custom 401 Unauthorized: redirect browsers to /login, return JSON for API clients
    401({ message }) {
      const accept = wire.headers.get("accept") || "";
      if (accept.includes("text/html")) {
        return wire.redirect("/login");
      }
      return { error: "Unauthorized", reason: message };
    },

    // 3. Custom 403 Forbidden: stream a static HTML file while keeping status 403
    403: wire.file("./pages/403.html"),

    // 4. Custom 500 Internal Server Error
    500() {
      return wire.html`<h1>500 — Something went wrong on our end</h1>`;
    },
  },

  api: {
    admin: guard(requireAdmin, {
      get: () => wire.html`<h1>Welcome, Admin ${wire.session.user}</h1>`,
    }),
  },
});
```

**Context passed to custom error functions `errors[code](ctx)`:**

| Property  | Type            | Description                                                                 |
| :-------- | :-------------- | :-------------------------------------------------------------------------- |
| `status`  | `number`        | HTTP status code being returned (e.g., `404`, `401`, `403`, `500`).         |
| `message` | `string`        | Default error message (e.g., the message passed to `wire.abort(401, msg)`). |
| `details` | `any`           | Validation field details when `status === 422`.                             |
| `path`    | `string`        | Request URL pathname (e.g., `'/admin'`).                                    |
| `method`  | `string`        | Uppercase HTTP method (e.g., `'GET'`).                                      |
| `error`   | `Error \| null` | Original thrown error instance if available.                                |
| `wire`    | `object`        | Active `wire` ambient context handle.                                       |

---

## 6. Server Configuration (`serve`)

### 6.1 All `serve()` Options

| Option            | Type                                   | Default                       | Description                                                                               |
| :---------------- | :------------------------------------- | :---------------------------- | :---------------------------------------------------------------------------------------- |
| `port`            | `number`                               | `3000`                        | TCP port to listen on. Pass `0` for a random OS-assigned port.                            |
| `host`            | `string`                               | `'127.0.0.1'`                 | Host interface to bind (use `'0.0.0.0'` inside Docker/containers).                        |
| `api`             | `object`                               | `{}`                          | Root domain object defining all routes.                                                   |
| `static`          | `string \| StaticDescriptor \| object` | `null`                        | Root or prefix-mapped static files/directories (e.g., `{ '/assets': './public' }`).       |
| `errors`          | `object`                               | `undefined`                   | Custom status handlers (`404`, `401`, `403`, `500`, `'4xx'`, `'5xx'`, `default`).         |
| `types`           | `object`                               | `{}`                          | Named custom parameter types usable via `param('typeName', branch)`.                      |
| `session`         | `object \| null`                       | `null`                        | Session config `{ secret, ttl, cookieName, rolling, secure, sameSite, store }`.           |
| `origins`         | `string[]`                             | `undefined`                   | Allowed CORS origins (e.g., `['https://app.example.com']` or `['*']`).                    |
| `redact`          | `string[]`                             | `undefined`                   | Wildcard keys (e.g., `['password*', '*.secret']`) stripped from all JSON responses.       |
| `message`         | `string \| function \| false`          | `"[servin] listening on ..."` | Custom startup log message or `false` to silence startup output.                          |
| `onListen`        | `function`                             | `undefined`                   | Sync/async callback `({ port, host, url }) => void` run when listening starts.            |
| `accessLog`       | `boolean \| function`                  | `true`                        | Enables per-request access logs or accepts a custom formatter `(info) => string \| null`. |
| `silent`          | `boolean`                              | `false`                       | Disables both startup and access logs.                                                    |
| `lagThresholdMs`  | `number`                               | `60`                          | Event-loop p95 delay threshold (ms) before `priority: 'low'` routes return `503`.         |
| `synthesizeTests` | `string`                               | `undefined`                   | File path where verified requests are recorded as `node:test` test cases.                 |
| `snapshotOnError` | `string`                               | `undefined`                   | Directory where `500` error snapshots are saved for local `replay()`.                     |
| `onError`         | `function`                             | `undefined`                   | Custom unhandled error formatter `(err, { req }) => Response \| object`.                  |

### 6.2 Server Instance Control (`port`, `url`, `fetch`, `close`)

```javascript
const app = await serve({
  port: 0,
  api: { ping: { get: () => ({ pong: true }) } },
});

console.log(app.port); // Actual assigned port
console.log(app.url); // e.g. "http://127.0.0.1:51234"

// Call routes directly in-memory without network overhead:
const res = await app.fetch(new Request("http://localhost/ping"));
console.log(await res.json()); // { pong: true }

// Shut down server and wait for pending wire.defer() tasks:
await app.close();
```

---

## 7. Domain-Tree Projection & Routing

### 7.1 Static, Dynamic, Typed, and Wildcard Segments

- **Static (`users`):** Matches `/users` literally.
- **Dynamic (`$username`):** Matches any single URL segment as a string.
- **Typed Dynamic (`$id: param(...)`):** Validates and converts the segment type before matching.
- **Wildcard (`$path`):** Captures all remaining trailing path segments joined by `/`.

```javascript
const api = {
  users: {
    me: { get: () => "static" }, // GET /users/me
    $id: param("int", { get: (id) => ({ id }) }), // GET /users/42
    $username: { get: (u) => ({ username: u }) }, // GET /users/nadia
  },
  files: {
    $path: { get: (path) => ({ path }) }, // GET /files/docs/2026/a.pdf
  },
};
```

### 7.2 Automatic Route Matching Priority

Regardless of object key order, `servin` always matches segments from most specific to least specific:

1. **Static segments** (`me`)
2. **Typed parameters** (`$id: param(...)`)
3. **Untyped parameters** (`$username`)
4. **Wildcard catch-all** (`$path` or `serveStatic` mount)

### 7.3 Method Unions (`'put|patch'`) & Shorthand Leaf Functions

**1. Method Unions:** Share one handler across multiple HTTP verbs using `|`:

```javascript
const items = {
  $id: param("int", {
    "put|patch"(id, payload) {
      return { methodUsed: wire.method, id, payload };
    },
  }),
};
```

**2. Shorthand Leaf Functions:** Assigning a function directly to a non-verb key creates a route automatically:

- Normal function $\rightarrow$ **`POST`**
- Async generator (`async *`) $\rightarrow$ **`GET`** (SSE stream)

```javascript
const actions = {
  // POST /actions/sync
  sync(payload) {
    return { synced: true, payload };
  },

  // GET /actions/events (SSE stream)
  async *events() {
    yield { status: "started" };
    yield { status: "finished" };
  },
};
```

### 7.4 Handler Argument Order

Arguments are always passed in this order:

1. URL parameters (`$...`) from left to right.
2. Parsed `payload` (only for `POST`, `PUT`, `PATCH`).
3. `query` object (`url.searchParams`) as the final argument.

```javascript
// PATCH /orgs/10/members/550e8400-e29b-41d4-a716-446655440000?notify=true
const orgs = {
  $orgId: param("int", {
    members: {
      $memberId: param("uuid", {
        patch(orgId, memberId, payload, query) {
          return { orgId, memberId, payload, notify: query.notify };
        },
      }),
    },
  }),
};
```

### 7.5 Typed Route Parameters (`param`) — All Supported Types & Custom Formats

`param(rule, branch)` keeps object keys as clean JavaScript identifiers without string quotes. When a URL segment does not satisfy `rule`, `servin` treats that route branch as non-matching (falling through to other routes or returning `404 Not Found`). When it does satisfy `rule`, `servin` passes the **converted value** directly into your handler.

You can supply `rule` in **five ways**:

#### A. Built-in String Type Names

| Rule        | Validation                               | Coerced JS Type      | Example Match                          | Example Rejected (`404`) |
| :---------- | :--------------------------------------- | :------------------- | :------------------------------------- | :----------------------- |
| `'int'`     | Non-negative safe integer (`/^\d+$/`)    | `number`             | `0`, `42`                              | `-1`, `3.14`, `42abc`    |
| `'number'`  | Signed integer or decimal                | `number`             | `-10`, `19.99`                         | `10px`, `abc`            |
| `'float'`   | Alias for `'number'`                     | `number`             | `-0.5`, `12.34`                        | `abc`                    |
| `'bigint'`  | Arbitrary-precision integer              | `bigint`             | `9007199254740993`                     | `12.5`, `abc`            |
| `'uuid'`    | Standard UUID v1–v5                      | `string` (lowercase) | `550e8400-e29b-41d4-a716-446655440000` | `12345`, `not-uuid`      |
| `'alpha'`   | Letters only (`a-z`, `A-Z`)              | `string`             | `Indonesia`                            | `id2`, `en-US`           |
| `'alnum'`   | Letters and digits (`a-z`, `A-Z`, `0-9`) | `string`             | `v2026`                                | `v-2026`                 |
| `'slug'`    | Lowercase kebab-case (`a-z`, `0-9`, `-`) | `string`             | `hello-world`                          | `Hello_World`            |
| `'bool'`    | `'true'`, `'1'`, `'false'`, `'0'`        | `boolean`            | `true`, `1`, `0`                       | `yes`, `2`               |
| `'boolean'` | Alias for `'bool'`                       | `boolean`            | `true`, `false`                        | `maybe`                  |
| `'string'`  | Any URI-decoded string                   | `string`             | `anything`                             | Invalid `%` encoding     |

```javascript
const users = {
  $id: param("int", {
    get: (id) => ({ id, isNumber: typeof id === "number" }),
  }),
  $handle: param("slug", {
    get: (handle) => ({ handle }),
  }),
};
```

#### B. Native JavaScript Constructors

Pass `Number`, `Boolean`, `BigInt`, or `String` directly:

```javascript
const posts = {
  $id: param(Number, { get: (id) => ({ id }) }),
  $published: param(Boolean, { get: (flag) => ({ published: flag }) }),
  $ledgerId: param(BigInt, { get: (val) => ({ ledgerId: val.toString() }) }),
};
```

#### C. Inline `RegExp` Literals (Custom Formats)

Pass any `RegExp` literal directly for custom code formats, SKUs, or structured identifiers:

```javascript
const products = {
  // Matches /products/SKU-1024, rejects /products/sku-1024 or /products/1024
  $sku: param(/^[A-Z]{3}-\d{4}$/, {
    get: (sku) => ({ sku }),
  }),
};
```

#### D. Custom Validator / Transformer Function

Pass a function `(rawSegment) => parsedValue | null | undefined | false`:

- Return any non-null, non-undefined value (other than `false`) to **accept** and pass that returned value to the handler.
- Return `null`, `undefined`, or `false` (or throw an error) to **reject** (`404`).

```javascript
const events = {
  // Parses "YYYY-MM-DD" into a real Date instance
  $date: param(
    (raw) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const d = new Date(`${raw}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    },
    {
      get: (date) => ({ iso: date.toISOString() }),
    },
  ),
};
```

#### E. Global Reusable Custom Types (`serve({ types })`)

Define named types once in `serve({ types })`—using either a `RegExp` or a validator function—and reference them by string name anywhere in your tree:

```javascript
await serve({
  port: 3000,
  types: {
    invoiceCode: /^INV-\d{6}$/,
    positiveInt: (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    },
  },
  api: {
    invoices: {
      $code: param("invoiceCode", { get: (code) => ({ code }) }),
    },
    pages: {
      $page: param("positiveInt", { get: (page) => ({ page }) }),
    },
  },
});
```

---

## 8. Response Formatting, HTML & Streaming

### 8.1 Automatic `Content-Type` Matrix

| Return Value                    | Status            | `Content-Type`                     | Notes                                                       |
| :------------------------------ | :---------------- | :--------------------------------- | :---------------------------------------------------------- |
| Object / Array                  | `200`             | `application/json`                 | Applies `redact` and `?fields=` automatically.              |
| `wire.html(...)`                | `200`             | `text/html; charset=utf-8`         | Sends rendered HTML.                                        |
| `wire.file(path)`               | `200`/`206`/`304` | Auto from extension                | Streams file with `ETag` and `Range` support.               |
| `string`                        | `200`             | `text/plain; charset=utf-8`        | Plain text (unless `Content-Type` header was set manually). |
| `null` / `undefined`            | `204`             | _(none)_                           | Empty response body.                                        |
| `async *generator()`            | `200`             | `text/event-stream; charset=utf-8` | Streams SSE `data: <json>\n\n` frames.                      |
| `ReadableStream` / `Uint8Array` | `200`             | _(user-defined)_                   | Streams raw binary bytes.                                   |
| Web `Response`                  | Custom            | Custom                             | Sent as-is.                                                 |

### 8.2 HTML Responses & XSS Protection (`wire.html`)

**1. Raw HTML string:**

```javascript
const page = {
  get: () => wire.html("<h1>Hello World</h1>"),
};
```

**2. Tagged template literal (auto-escapes untrusted variables against XSS):**

```javascript
const profile = {
  $name: {
    get(name) {
      // If `name` is "<script>alert(1)</script>", it is safely escaped to &lt;script&gt;...
      return wire.html`<h1>Profile: ${name}</h1>`;
    },
  },
};
```

**3. Composing nested `wire.html` fragments safely:**

```javascript
const dashboard = {
  get() {
    const items = ["Apples", "Bananas"].map(
      (item) => wire.html`<li>${item}</li>`,
    );
    // Nested `wire.html` values and arrays are NOT double-escaped
    return wire.html`<ul>${items}</ul>`;
  },
};
```

### 8.3 File Streaming with `ETag` & Byte-Range (`wire.file`)

```javascript
const landing = {
  get: () => wire.file("./public/index.html"),
};
```

### 8.4 Server-Sent Events (SSE) with Async Generators

Use `async *get()` to stream live updates. If the client disconnects early, `servin` automatically stops the generator and runs any `wire.undo()` cleanup:

```javascript
const clock = {
  async *get() {
    for (let i = 0; i < 5; i++) {
      yield { tick: i, time: new Date().toISOString() };
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
};
```

### 8.5 Sparse Fieldsets (`?fields=`) & Automatic Redaction (`redact`)

- **`redact`:** Strips sensitive keys globally from all JSON responses.
- **`?fields=`:** Allows clients on any `GET` endpoint to request only the fields they need.

```javascript
await serve({
  port: 3000,
  redact: ["password*", "*.secret"],
  api: {
    users: {
      get: () => [
        {
          id: 1,
          name: "Nadia",
          email: "nadia@example.com",
          passwordHash: "xyz",
        },
      ],
    },
  },
});
// GET /users?fields=id,name -> [{ "id": 1, "name": "Nadia" }]
```

---

## 9. Security, Sessions & Traffic Control

### 9.1 Protecting Routes & Branches (`guard`)

**Step 1 — Guard a single endpoint:**

```javascript
import { wire, guard } from "servin";

function requireAuth() {
  if (!wire.session.userId) wire.abort(401, "Please sign in");
}

const secretNote = guard(requireAuth, {
  get: () => ({ secret: "Top secret data" }),
});
```

**Step 2 — Guard an entire branch and stack multiple guards:**

```javascript
function requireAdmin() {
  if (wire.session.role !== "admin") wire.abort(403, "Admins only");
}

// `requireAuth` runs first on everything inside `dashboard`,
// and `requireAdmin` also runs on everything inside `admin`.
const dashboard = guard(requireAuth, {
  overview: {
    get: () => ({ userId: wire.session.userId }),
  },
  admin: guard(requireAdmin, {
    settings: {
      get: () => ({ maintenanceMode: false }),
    },
  }),
});
```

### 9.2 Lazy Encrypted Sessions (`wire.session` & `wire.sessions`)

Sessions use AES-256-GCM encrypted `HttpOnly` cookies and are **completely lazy**: if a route never reads or writes `wire.session`, cookies are never decrypted and the session store is never touched.

**Step 1 — Enable sessions in `serve()` and read/write properties:**

```javascript
await serve({
  port: 3000,
  session: { secret: "replace-with-32-char-secret-key!!" },
  api: {
    counter: {
      get() {
        wire.session.views = (wire.session.views || 0) + 1;
        return { views: wire.session.views };
      },
    },
  },
});
```

**Step 2 — Rotate session ID on login & destroy on logout:**

```javascript
const auth = {
  login: {
    async post({ userId, role }) {
      await wire.session.rotate(); // Prevents session fixation
      wire.session.userId = userId;
      wire.session.role = role;
      return { loggedIn: true };
    },
  },
  logout: {
    post() {
      wire.session = null; // Deletes store record, clears cookie, closes active WS
      return { loggedOut: true };
    },
  },
};
```

**Step 3 — Multi-device session listing & remote revocation:**

```javascript
const devices = {
  // Bind session to a userId during login: `wire.session.bind(userId)`
  get: () => wire.sessions.list(wire.session.userId),

  revokeOthers: {
    async post() {
      const count = await wire.sessions.revokeOthers(wire.session.userId);
      return { revokedDevices: count };
    },
  },
};
```

### 9.3 Custom Session Store Interface (Redis / Database)

Pass a custom `store` object to `session` for multi-server deployments:

```javascript
const customStore = {
  async get(sid) {
    /* return { userId, data, createdAt, updatedAt, expiresAt } | null */
  },
  async set(sid, record) {
    /* persist record */
  },
  async delete(sid) {
    /* delete sid */
  },
  async listByUser(userId) {
    /* return array of active session summaries */
  },
  async revokeOthers(userId, currentSid) {
    /* delete all user sessions except currentSid; return revoked sids */
  },
};

await serve({
  port: 3000,
  session: { secret: process.env.SESSION_SECRET, store: customStore },
  api: {},
});
```

### 9.4 Timing-Safe Webhook Verification (`webhook`)

Verify HMAC signatures automatically over the raw body before JSON parsing:

```javascript
const stripeWebhook = {
  webhook: {
    secret: process.env.STRIPE_WEBHOOK_SECRET,
    header: "stripe-signature",
    algo: "sha256",
  },
  post(event) {
    return { received: true, type: event.type };
  },
};
```

### 9.5 Rate Limiting (`limit` & `wire.cost`)

**Step 1 — Basic rate limit per window:**

```javascript
const search = {
  limit: { max: 30, window: "1m" },
  get: (query) => ({ results: [], q: query.q }),
};
```

**Step 2 — Dynamic point costs with `wire.cost()`:**

Each request costs `1` point by default. Call `wire.cost(points)` to penalize failed attempts or refund valid ones:

```javascript
const login = {
  limit: {
    max: 10,
    window: "10m",
    key: (payload) => `login:${payload?.email || "unknown"}`,
  },
  async post(payload) {
    const valid = payload.password === "secret123";
    if (!valid) {
      wire.cost(5); // Failed attempts consume 5x quota
      wire.abort(401, "Invalid credentials");
    }
    wire.cost(0); // Successful login costs 0 points
    return { ok: true };
  },
};
```

### 9.6 CORS & Preflight Handling (`origins`)

```javascript
await serve({
  port: 3000,
  origins: ["https://app.example.com", "http://localhost:5173"],
  api: {},
});
```

---

## 10. Caching, Validation & Resilience

### 10.1 Self-Invalidating Response Cache (`cache`)

**Step 1 — Cache a `GET` endpoint:**

```javascript
const stats = {
  cache: "1m", // Cached for 1 minute
  get: () => ({ generatedAt: Date.now() }),
};
```

**Step 2 — Automatic invalidation on mutations:**

When `cache` is placed on a parent or item node, any successful `POST`, `PUT`, `PATCH`, or `DELETE` automatically clears both the item cache and parent list cache:

```javascript
const articles = {
  cache: "5m",
  get: () => db.articles.all(),
  post: (data) => db.articles.create(data), // Automatically clears GET /articles cache

  $id: param("int", {
    cache: "5m",
    get: (id) => db.articles.find(id),
    patch: (id, data) => db.articles.update(id, data), // Clears GET /articles/:id AND GET /articles
  }),
};
```

### 10.2 Request Coalescing (`coalesce`)

Deduplicate simultaneous identical `GET` requests during traffic spikes so your database runs the query only once:

```javascript
const report = {
  coalesce: true,
  cache: "30s",
  async get() {
    return await db.runExpensiveQuery();
  },
};
```

### 10.3 Idempotent Mutations (`idempotent`)

Prevent duplicate writes when clients retry requests with the same `Idempotency-Key` header:

```javascript
const payments = {
  idempotent: "24h",
  async post(payload) {
    return await chargeCustomer(payload);
  },
};
```

### 10.4 Declarative Input Validation (`expect`)

**Step 1 — Validate basic required fields (returns `422` if invalid):**

```javascript
const signup = {
  expect: {
    email: "email",
    password: "string",
    age: "number",
  },
  post(payload) {
    return { created: payload.email };
  },
};
```

**Step 2 — Optional fields (`?`), enums, arrays, and nested objects:**

```javascript
const createProject = {
  expect: {
    name: "string",
    visibility: ["private", "team", "public"], // Enum
    description: "string?", // Optional string
    tags: "array?", // Optional array
    settings: {
      // Nested object
      notifications: "boolean",
    },
  },
  post: (payload) => payload,
};
```

### 10.5 Automatic Rollbacks (`wire.undo`) & Dry-Runs (`X-Simulate`)

**Step 1 — Register undo actions after each side effect:**

If a later step throws an error or calls `wire.abort()`, `servin` runs all `wire.undo()` functions in reverse order (LIFO):

```javascript
const transfer = {
  async post({ from, to, amount }) {
    await db.debit(from, amount);
    wire.undo(() => db.credit(from, amount)); // Runs automatically if credit() below fails

    await db.credit(to, amount);
    return { transferred: amount };
  },
};
```

**Step 2 — Speculative dry-runs via `X-Simulate: true`:**

When a client sends header `X-Simulate: true`, `servin` executes your handler to compute the exact response, then automatically runs `wire.undo()` so no state changes persist.

### 10.6 Graceful Background Tasks (`wire.defer`)

Run non-blocking work after sending the HTTP response. `servin` waits for all deferred tasks to finish during server shutdown:

```javascript
const register = {
  async post(user) {
    const saved = await db.users.insert(user);
    wire.defer(() => sendWelcomeEmail(saved.email));
    wire.status(201);
    return saved;
  },
};
```

### 10.7 Load Shedding (`priority: 'low'`) & Deprecation (`sunset`)

```javascript
const exportsApi = {
  sunset: "2027-01-01", // Emits standard Deprecation and Sunset headers
  csv: {
    priority: "low", // Returns 503 Retry-After: 2 if event loop p95 lag > lagThresholdMs
    get: () => buildHeavyCsv(),
  },
};
```

---

## 12. Streaming File Uploads (`wire.multipart` & `rawBody`)

**1. Streaming `multipart/form-data` without buffering in RAM:**

```javascript
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { wire } from "servin";

const upload = {
  async post() {
    const fields = {};
    const files = [];

    for await (const part of wire.multipart({ maxFileSize: "20mb" })) {
      if (part.isField) {
        fields[part.name] = await part.text();
      } else if (part.isFile) {
        const dest = `./uploads/${part.filename}`;
        await pipeline(
          Readable.fromWeb(part.stream),
          fs.createWriteStream(dest),
        );
        files.push(part.filename);
      }
    }

    return { fields, files };
  },
};
```

**2. Raw unbuffered binary upload (`rawBody: true`):**

```javascript
const rawUpload = {
  $filename: {
    rawBody: true,
    async put(filename) {
      await pipeline(
        Readable.fromWeb(wire.stream),
        fs.createWriteStream(`./uploads/${filename}`),
      );
      wire.status(201);
      return { saved: filename };
    },
  },
};
```

---

## 13. Decoupled Side Effects (`reactTo`)

Attach secondary side effects (analytics, loyalty points, audit logs) from outside your main handler without coupling modules together:

```javascript
import { reactTo } from "servin";

reactTo(tasks.post, ({ output }) => {
  console.log(`Audit: task #${output.id} created`);
});
```

---

## 14. Logging, Debugging & Automated Testing

### 14.1 Startup Messages & Access Logs (`message`, `onListen`, `accessLog`)

**1. Custom startup message:**

```javascript
await serve({
  port: 3000,
  message: ({ port, url }) => `Server running on port ${port} (${url})`,
  api: {},
});
```

**2. Custom access log formatter (or `accessLog: false` to disable):**

```javascript
await serve({
  port: 3000,
  accessLog(info) {
    if (info.url.pathname === "/health") return null; // Hide healthchecks
    return `[${info.status}] ${info.method} ${info.url.pathname} (${info.durationMs.toFixed(1)}ms)`;
  },
  api: {},
});
```

### 14.2 Error-Triggered Debug Trace (`wire.log.debug`) & `Server-Timing` (`wire.mark`)

- `wire.log.debug(...)` buffers logs in memory and **only prints them if the request fails with an unhandled error**.
- `wire.mark(label)` measures step duration and emits an HTTP `Server-Timing` header.

```javascript
const report = {
  async get() {
    wire.log.debug("Querying analytics table");

    const endDb = wire.mark("db");
    const rows = await db.query("SELECT * FROM metrics");
    endDb();

    return rows; // Emits header: Server-Timing: db;dur=12.40
  },
};
```

### 14.3 Automated Test Synthesis (`synthesizeTests`)

Set `synthesizeTests: './tests/api.test.js'` in `serve()` during development to automatically record verified endpoints into a runnable `node:test` file.

### 14.4 Error Snapshots & Local Replay (`snapshotOnError` & `replay`)

Set `snapshotOnError: './snapshots'` to save failing `500` requests, then replay them locally against your handler:

```javascript
import { replay } from "servin/test";
import { tasks } from "./tasks.js";

await replay(
  tasks.$id.get,
  "./snapshots/err-2026-11-25T12-00-00-000Z-a1b2c3d4.json",
);
```

---

## 15. Complete Ambient `wire` API Reference

| Member                       | Signature / Type                  | Description                                                                                                              |
| :--------------------------- | :-------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `wire.req`                   | `Request`                         | Native Web `Request` instance.                                                                                           |
| `wire.method`                | `string`                          | Uppercase HTTP method (`'GET'`, `'POST'`, etc.) or `'WS'`.                                                               |
| `wire.url`                   | `URL`                             | Parsed `URL` instance for the current request.                                                                           |
| `wire.headers`               | `Headers` (Proxy)                 | Reads response then request headers (`.get()`, `.has()`); mutates response headers (`.set()`, `.append()`, `.delete()`). |
| `wire.stream`                | `ReadableStream \| null`          | Unbuffered request body stream (used with `rawBody: true`).                                                              |
| `wire.signal`                | `AbortSignal`                     | Aborted if the client disconnects early.                                                                                 |
| `wire.status(code)`          | `(number) => void`                | Sets the HTTP status code.                                                                                               |
| `wire.abort(status, msg)`    | `(number, string) => never`       | Halts execution, triggers `wire.undo()`, and sends `{ error: msg }`.                                                     |
| `wire.redirect(url, status)` | `(string, number?) => never`      | Halts execution, commits session cookies, and sends a redirect (`302` by default).                                       |
| `wire.undo(fn)`              | `(() => any) => void`             | Registers a LIFO rollback callback run on error, abort, SSE cancel, or `X-Simulate: true`.                               |
| `wire.defer(fn)`             | `(() => any) => void`             | Schedules a background task tracked during graceful shutdown.                                                            |
| `wire.html`                  | `tag \| (string) => HtmlResponse` | Creates an HTML response; escapes interpolated variables when used as a tagged template.                                 |
| `wire.file(filePath)`        | `(string) => FileStreamResponse`  | Streams a file with `ETag` (`304`) and `Range` (`206`) support.                                                          |
| `wire.multipart(opts)`       | `(opts?) => AsyncGenerator`       | Iterates streaming `multipart/form-data` fields and files sequentially.                                                  |
| `wire.session`               | `Proxy \| null`                   | Lazy encrypted session object (`.rotate()`, `.bind(userId)`, or `wire.session = null`).                                  |
| `wire.sessions`              | `{ list, revokeOthers }`          | Multi-device session listing and remote session revocation helpers.                                                      |
| `wire.cost(points)`          | `(number) => void`                | Adjusts rate-limit quota consumption for the current request.                                                            |
| `wire.log.debug(msg, meta)`  | `(string, any?) => void`          | Buffers a debug log entry emitted only on unhandled errors.                                                              |
| `wire.mark(label)`           | `(string) => () => number`        | Starts a performance timer; calling the returned function records `Server-Timing`.                                       |

---

## 16. License

MIT
