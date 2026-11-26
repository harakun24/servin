import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, wire, guard, param, serveStatic, redirect, alias } from '../index.js';

test('Static routing, Redirect, dan Custom Error Pages (404, 401, 403)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servin-extra-'));
  await fs.mkdir(path.join(tmpDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'index.html'), '<h1>Home Static</h1>', 'utf8');
  await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=123', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'assets', 'app.js'), 'console.log("ok");', 'utf8');
  const forbiddenPage = path.join(tmpDir, '403.html');
  await fs.writeFile(forbiddenPage, '<h1>403 Dilarang Masuk</h1>', 'utf8');

  const requireAdmin = () => {
    if (!wire.session.user) wire.abort(401, 'Belum login');
    if (wire.session.role !== 'admin') wire.abort(403, 'Bukan admin');
  };

  const instance = await serve({
    port: 0,
    silent: true,
    session: { secret: 'secret-testing-key-32-characters!!' },
    static: {
      '/': tmpDir
    },
    errors: {
      404({ path: reqPath }) {
        return wire.html`<h1>404 Custom: ${reqPath}</h1>`;
      },
      401({ message }) {
        return { customUnauthorized: true, reason: message };
      },
      403: wire.file(forbiddenPage)
    },
    api: {
      assets: serveStatic(path.join(tmpDir, 'assets'), { cacheControl: 'max-age=3600' }),
      'old-url': redirect('/new-url', 301),
      'new-url': {
        get: () => ({ arrived: true })
      },
      login: {
        async post({ role }) {
          wire.session.user = 'andi';
          wire.session.role = role;
          wire.redirect('/admin');
        }
      },
      admin: guard(requireAdmin, {
        get: () => ({ secretPanel: true })
      })
    }
  });

  const base = instance.url;

  try {
    // 1. Static folder & index.html
    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    assert.equal(await rootRes.text(), '<h1>Home Static</h1>');

    const jsRes = await fetch(`${base}/assets/app.js`);
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get('cache-control'), 'max-age=3600');
    assert.equal(await jsRes.text(), 'console.log("ok");');

    // 2. Dotfile (.env) otomatis diblokir -> masuk ke custom 404
    const envRes = await fetch(`${base}/.env`);
    assert.equal(envRes.status, 404);
    assert.equal(await envRes.text(), '<h1>404 Custom: /.env</h1>');

    // 3. Redirect deklaratif 301
    const redirRes = await fetch(`${base}/old-url`, { redirect: 'manual' });
    assert.equal(redirRes.status, 301);
    assert.equal(redirRes.headers.get('location'), '/new-url');

    // 4. Custom 401 Unauthorized
    const unauthRes = await fetch(`${base}/admin`);
    assert.equal(unauthRes.status, 401);
    assert.deepEqual(await unauthRes.json(), {
      customUnauthorized: true,
      reason: 'Belum login'
    });

    // 5. wire.redirect() menyimpan cookie session, lalu akses admin sebagai member -> Custom 403 HTML file
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
      redirect: 'manual'
    });
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.get('location'), '/admin');
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const forbiddenRes = await fetch(`${base}/admin`, {
      headers: { Cookie: cookie }
    });
    assert.equal(forbiddenRes.status, 403);
    assert.equal(await forbiddenRes.text(), '<h1>403 Dilarang Masuk</h1>');
  } finally {
    await instance.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Alias routing (config alias, helper alias(), dynamic params, guards, query merge, and loop protection)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servin-alias-'));
  await fs.mkdir(path.join(tmpDir, 'pages'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'home.html'), '<h1>Home Page</h1>', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'about.html'), '<h1>About Page</h1>', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'secret.html'), '<h1>Secret Page</h1>', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'pages', 'intro.html'), '<h1>Intro Docs</h1>', 'utf8');

  const requireAuth = () => {
    if (wire.headers.get('x-auth') !== 'ok') {
      wire.abort(401, 'Unauthorized');
    }
  };

  const instance = await serve({
    port: 0,
    silent: true,
    static: {
      '/': tmpDir
    },
    alias: {
      '/': '/home.html',
      '/home': '/home.html',
      '/docs/$slug': '/pages/$slug.html',
      '/loop-a': '/loop-b',
      '/loop-b': '/loop-a'
    },
    api: {
      about: alias('/about.html'),
      secret: guard(requireAuth, alias('/secret.html')),
      'active-items': alias('/v2/items?status=active'),
      user: {
        $id: param('int', alias((id) => `/v2/users/${id}`))
      },
      v2: {
        items: {
          get(query) {
            return { items: true, status: query.status, sort: query.sort || null };
          },
          post(payload) {
            return { created: payload };
          }
        },
        users: {
          $id: param('int', {
            get(id) {
              return { userId: id };
            }
          })
        }
      }
    }
  });

  const base = instance.url;

  try {
    // 1. /home mengakses /home.html tanpa redirect (status 200)
    const homeRes = await fetch(`${base}/home`, { redirect: 'manual' });
    assert.equal(homeRes.status, 200);
    assert.match(homeRes.headers.get('content-type'), /text\/html/);
    assert.equal(await homeRes.text(), '<h1>Home Page</h1>');

    // 2. Root / alias ke /home.html
    const rootRes = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(rootRes.status, 200);
    assert.equal(await rootRes.text(), '<h1>Home Page</h1>');

    // 3. Helper alias() di dalam api tree
    const aboutRes = await fetch(`${base}/about`, { redirect: 'manual' });
    assert.equal(aboutRes.status, 200);
    assert.equal(await aboutRes.text(), '<h1>About Page</h1>');

    // 4. Dynamic param interpolation pada config alias (/docs/$slug -> /pages/$slug.html)
    const docsRes = await fetch(`${base}/docs/intro`);
    assert.equal(docsRes.status, 200);
    assert.equal(await docsRes.text(), '<h1>Intro Docs</h1>');

    // 5. Guard pada alias route
    const unauthRes = await fetch(`${base}/secret`);
    assert.equal(unauthRes.status, 401);

    const authRes = await fetch(`${base}/secret`, { headers: { 'x-auth': 'ok' } });
    assert.equal(authRes.status, 200);
    assert.equal(await authRes.text(), '<h1>Secret Page</h1>');

    // 6. Alias ke API route (GET dengan default query + incoming query, dan POST)
    const itemsGet = await fetch(`${base}/active-items?sort=asc`);
    assert.equal(itemsGet.status, 200);
    assert.deepEqual(await itemsGet.json(), { items: true, status: 'active', sort: 'asc' });

    const itemsPost = await fetch(`${base}/active-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Book' })
    });
    assert.equal(itemsPost.status, 200);
    assert.deepEqual(await itemsPost.json(), { created: { name: 'Book' } });

    // 7. Dynamic resolver function pada alias()
    const userRes = await fetch(`${base}/user/42`);
    assert.equal(userRes.status, 200);
    assert.deepEqual(await userRes.json(), { userId: 42 });

    // 8. Method yang tidak didukung target tetap mengembalikan 405
    const postHomeRes = await fetch(`${base}/home`, { method: 'POST' });
    assert.equal(postHomeRes.status, 405);

    // 9. Proteksi loop tak terbatas pada alias
    const loopRes = await fetch(`${base}/loop-a`);
    assert.equal(loopRes.status, 500);
  } finally {
    await instance.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});