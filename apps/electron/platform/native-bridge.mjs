import { t as uiText } from './native-ui-language.mjs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export async function createNativeBridge(invoke) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (
      req.headers.origin ||
      req.method !== 'POST' ||
      req.url !== '/desktop' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Desktop bridge access denied' }));
      return;
    }
    try {
      let data = '';
      for await (const part of req) {
        data += part;
        if (Buffer.byteLength(data) > 64000) throw Error(uiText('请求过大'));
      }
      const { operation, payload } = JSON.parse(data);
      const result = await invoke(operation, payload);
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/desktop`,
    token,
    close: () => server.close(),
  };
}
