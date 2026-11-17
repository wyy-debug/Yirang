import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createLightAppsCore } from './light-apps-core.mjs';

// A single per-profile process owns SQLite, schedules and all app runtimes.
const [directory, pipe] = process.argv.slice(2),
  token = readFileSync(join(directory, 'host-token'), 'utf8');
let core,
  heartbeat = Date.now(),
  detached = false;
const server = createServer(async (req, res) => {
  try {
    const supplied = Buffer.from(String(req.headers.authorization || '')),
      expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw Error('Unauthorized');
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 4000000) throw Error('请求过大');
    }
    const p = JSON.parse(text);
    let value;
    if (p.operation === 'attach') {
      heartbeat = Date.now();
      detached = false;
      core.attach(p.payload?.key);
      value = { ready: true, protocol: 15 };
    } else if (p.operation === 'protocol') value = { protocol: 15 };
    else if (p.operation === 'heartbeat') {
      heartbeat = Date.now();
      value = { ready: true };
    } else if (p.operation === 'detach') {
      detached = true;
      core.detach();
      value = { detached: true };
    } else value = await core.command(p.workspaceId, p.operation, p.payload);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  } catch (error) {
    res
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error.message }));
  }
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') process.exit(0);
  console.error(error);
  process.exit(1);
});
server.listen(pipe, () => {
  core = createLightAppsCore({ directory });
  setInterval(() => {
    if (!detached && Date.now() - heartbeat > 45000) {
      detached = true;
      core.detach();
    }
    if (detached && !core.hasBackground()) {
      core.close();
      server.close(() => process.exit(0));
    }
  }, 10000).unref();
});
process.on('SIGTERM', () => {
  core?.close();
  server.close();
  process.exit(0);
});
