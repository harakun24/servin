import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, wire, guard, reactTo } from '../index.js';

test('Suite lengkap seluruh kapabilitas servin', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servin-test-'));
  const sampleHtmlPath = path.join(tmpDir, 'page.html');
  await fs.writeFile(sampleHtmlPath, '<h1>Static HTML File</h1>', 'utf8');

  let dbFetchCount = 0;
  let coalFetchCount = 0;
  let reactionTriggeredCount = 0;
  const itemsDb = new Map([
    ['1', { id: '1', title: 'Belajar Servin', status: 'draft', secretToken: 'hidden_xyz' }]
  ]);

  const requireAuth = () => {
    if (!wire.session.userId) wire.abort(401, 'Unauthorized');
  };

  const items = {
    // GET /items & POST /items
    cache: '5m',
    get() {
      dbFetchCount++;
      return [...itemsDb.values()];
    },
    expect: { title: 'string', status: ['draft', 'published'] },
    async post(payload) {
      const id = String(itemsDb.size + 1);
      const record = { id, ...payload, secretToken: 'secret_999' };
      itemsDb.set(id, record);
      wire.undo(() => itemsDb.delete(id));
      wire.status(201);
      return record;
    },

    // /items/:id -> GET, PATCH, DELETE
    $id: {
      cache: '5m',
      get(id) {
        dbFetchCount++;
        const item = itemsDb.get(id);
        if (!item) wire.abort(404, 'Item not found');
        return item;
      },
      patch(id, payload) {
        const item = itemsDb.get(id);
        if (!item) wire.abort(404, 'Item not found');
        Object.assign(item, payload);
        return item;
      },
      delete(id) {
        if (!itemsDb.has(id)) wire.abort(404, 'Item not found');
        itemsDb.delete(id);
        wire.status(204);
        return null;
      }
    }
  };

  reactTo(items.post, () => {
    reactionTriggeredCount++;
  });

  const instance = await serve({
    port: 0,
    silent: true,
    redact: ['secret*'],
    session: { secret: 'test-secret-key-32-chars-minimum!!' },
    api: {
      // 1. HTML string & XSS-safe template
      home: {
        get: () => wire.html`<div>Hello, ${'<script>alert(1)</script>'}</div>`
      },
      // 2. File streaming
      staticPage: {
        get: () => wire.file(sampleHtmlPath)
      },
      // 3. Request coalescing
      heavy: {
        coalesce: true,
        async get() {
          coalFetchCount++;
          await new Promise((r) => setTimeout(r, 40));
          return { computed: true };
        }
      },
      // 4. CRUD Items
      items,
      // 5. Auth & Session
      auth: {
        login: {
          async post({ userId }) {
            await wire.session.rotate();
            wire.session.bind(userId);
            wire.session.userId = userId;
            return { loggedIn: true };
          }
        },
        logout: {
          post() {
            wire.session = null;
            return { loggedOut: true };
          }
        }
      },
      // 6. Protected WebSocket
      chat: guard(requireAuth, {
        $room: {
          async ws(room, socket) {
            socket.join(`room:${room}`);
            socket.send({ event: 'connected', room, user: wire.session.userId });
            for await (const msg of socket) {
              wire.publish(`room:${room}`, { from: wire.session.userId, text: msg.text });
            }
          }
        }
      }),
      // 7. Multipart upload
      upload: {
        async post() {
          const fields = {};
          const files = [];
          for await (const part of wire.multipart()) {
            if (part.isField) fields[part.name] = await part.text();
            if (part.isFile) files.push({ name: part.filename, content: await part.text() });
          }
          return { fields, files };
        }
      }
    }
  });

  const base = instance.url;

  try {
    await t.test('1. HTML response dengan auto-escape XSS & File streaming', async () => {
      const resHtml = await fetch(`${base}/home`);
      assert.equal(resHtml.status, 200);
      assert.ok(resHtml.headers.get('content-type').includes('text/html'));
      const html = await resHtml.text();
      assert.equal(html, '<div>Hello, <script>alert(1)</script></div>');

      const resFile = await fetch(`${base}/staticPage`);
      assert.equal(resFile.status, 200);
      assert.equal(await resFile.text(), '<h1>Static HTML File</h1>');
    });

    await t.test('2. Self-invalidating cache otomatis bersih saat PATCH dipanggil & redaction bekerja', async () => {
      dbFetchCount = 0;

      // Hit pertama: baca dari DB
      const r1 = await fetch(`${base}/items/1`);
      const d1 = await r1.json();
      assert.equal(d1.status, 'draft');
      assert.equal(d1.secretToken, undefined); // Terhapus otomatis oleh redact
      assert.equal(dbFetchCount, 1);

      // Hit kedua: ambil dari cache (dbFetchCount tetap 1)
      const r2 = await fetch(`${base}/items/1`);
      assert.equal((await r2.json()).status, 'draft');
      assert.equal(dbFetchCount, 1);

      // Mutasi PATCH -> otomatis menghapus cache GET /items/1
      const patchRes = await fetch(`${base}/items/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' })
      });
      assert.equal(patchRes.status, 200);

      // Hit ketiga: cache sudah bersih, wajib membaca data terbaru dari DB
      const r3 = await fetch(`${base}/items/1`);
      assert.equal((await r3.json()).status, 'published');
      assert.equal(dbFetchCount, 2);
    });

    await t.test('3. Request coalescing menggabungkan 20 request paralel menjadi 1 eksekusi', async () => {
      coalFetchCount = 0;
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => fetch(`${base}/heavy`).then((r) => r.json()))
      );
      assert.equal(responses.length, 20);
      assert.equal(coalFetchCount, 1);
    });

    await t.test('4. Validasi expect (422), X-Simulate dry-run, dan reactTo', async () => {
      // Validasi gagal -> 422
      const badRes = await fetch(`${base}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 12345, status: 'invalid' })
      });
      assert.equal(badRes.status, 422);

      // Simulasi X-Simulate: true -> mengembalikan 201 tapi DB tidak bertambah
      const simRes = await fetch(`${base}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Simulate': 'true' },
        body: JSON.stringify({ title: 'Simulasi Saja', status: 'draft' })
      });
      assert.equal(simRes.status, 201);
      assert.equal(itemsDb.size, 1);
      assert.equal(reactionTriggeredCount, 0);

      // Eksekusi nyata -> masuk DB & memicu reactTo
      const realRes = await fetch(`${base}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Item Nyata', status: 'published' })
      });
      assert.equal(realRes.status, 201);
      assert.equal(itemsDb.size, 2);
      assert.equal(reactionTriggeredCount, 1);
    });

    await t.test('5. Multipart streaming multi-field dan multi-file', async () => {
      const form = new FormData();
      form.append('album', 'Liburan');
      form.append('note', 'Catatan penting');
      form.append('doc1', new Blob(['Isi file pertama'], { type: 'text/plain' }), 'satu.txt');
      form.append('doc2', new Blob(['Isi file kedua'], { type: 'text/plain' }), 'dua.txt');

      const res = await fetch(`${base}/upload`, { method: 'POST', body: form });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.fields, { album: 'Liburan', note: 'Catatan penting' });
      assert.equal(body.files.length, 2);
      assert.equal(body.files[0].content, 'Isi file pertama');
      assert.equal(body.files[1].content, 'Isi file kedua');
    });

    await t.test('6. Session Auth, WebSocket Linear Stream & Auto-Kick saat Logout', async () => {
      // Tanpa login -> ditolak 401 sebelum upgrade
      const unauthWs = await fetch(`${base}/chat/lobby`, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13'
        }
      });
      assert.equal(unauthWs.status, 401);

      // Login -> ambil cookie session
      const loginRes = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-77' })
      });
      assert.equal(loginRes.status, 200);
      const cookie = loginRes.headers.get('set-cookie').split(';')[0];

      // Buka koneksi WebSocket menggunakan cookie session
      const wsUrl = base.replace('http://', 'ws://') + '/chat/lobby';
      const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });

      const firstMsg = await new Promise((resolve, reject) => {
        ws.onmessage = (ev) => resolve(JSON.parse(ev.data));
        ws.onerror = reject;
      });
      assert.deepEqual(firstMsg, { event: 'connected', room: 'lobby', user: 'user-77' });

      // Logout lewat HTTP -> otomatis memutus koneksi WebSocket aktif dengan kode 4001
      const closePromise = new Promise((resolve) => {
        ws.onclose = (ev) => resolve(ev.code);
      });

      const logoutRes = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie }
      });
      assert.equal(logoutRes.status, 200);
      assert.equal(await closePromise, 4001);
    });

    await t.test('7. Virtual ESM Client (/@client.js) tersedia', async () => {
      const clientRes = await fetch(`${base}/@client.js`);
      assert.equal(clientRes.status, 200);
      const code = await clientRes.text();
      assert.ok(code.includes('export const api = createNode([])'));
    });
  } finally {
    await instance.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});