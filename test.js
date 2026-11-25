import fsp from 'node:fs/promises';
import { wireStorage, createRequestContext, runUndoStack } from './src/wire.js';

export async function replay(targetFn, snapshotPath) {
  if (typeof targetFn !== 'function') {
    throw new TypeError('replay(targetFn, snapshotPath) requires a target function');
  }

  const raw = await fsp.readFile(snapshotPath, 'utf8');
  const snapshot = JSON.parse(raw);

  const url = new URL(snapshot.url || 'http://localhost/');
  const req = new Request(url, {
    method: snapshot.method || 'GET',
    headers: new Headers(snapshot.headers || {})
  });

  const ctx = createRequestContext({
    req,
    method: snapshot.method || 'GET',
    url
  });

  let extractedArgs;
  if (snapshot.params && typeof snapshot.params === 'object') {
    extractedArgs = Object.values(snapshot.params);
  } else {
    const pathnameParts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    const dotParts = (snapshot.dotPath || '').split('.');
    extractedArgs = [];
    for (let i = 0; i < dotParts.length; i++) {
      if (dotParts[i].startsWith('$') && pathnameParts[i] !== undefined) {
        extractedArgs.push(decodeURIComponent(pathnameParts[i]));
      }
    }
  }

  return wireStorage.run(ctx, async () => {
    try {
      return await targetFn(...extractedArgs);
    } finally {
      await runUndoStack(ctx);
    }
  });
}