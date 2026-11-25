import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, wire, guard, serveStatic, redirect } from '../index.js';

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