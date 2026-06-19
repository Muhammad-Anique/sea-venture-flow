import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputDir = path.join(root, '.vercel', 'output');

// Run the regular Vite build
execSync('npm run build', { stdio: 'inherit' });

// Clean and create Vercel Output API structure
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outputDir, 'static'), { recursive: true });
fs.mkdirSync(path.join(outputDir, 'functions', 'index.func'), { recursive: true });

// Copy static client assets
copyDir(path.join(root, 'dist', 'client'), path.join(outputDir, 'static'));

// Copy built server into the edge function directory.
// With noExternal+inlineDynamicImports the build produces a single server.js.
const serverSrc = path.join(root, 'dist', 'server');
const funcDir = path.join(outputDir, 'functions', 'index.func');
copyDir(serverSrc, funcDir);

// Node.js Lambda entry — adapts the built Web Fetch handler to Vercel req/res format
fs.writeFileSync(
  path.join(funcDir, 'index.mjs'),
  `import server from './server.js';

export default async function handler(req, res) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url = new URL(req.url, \`\${proto}://\${host}\`);

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      for (const val of Array.isArray(v) ? v : [v]) headers.append(k, val);
    }

    const noBody = req.method === 'GET' || req.method === 'HEAD';
    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body: noBody ? undefined : body,
    });

    const response = await server.fetch(request, {}, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers.entries()) res.setHeader(k, v);

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    console.error('Lambda handler error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end('Internal server error: ' + (err && err.message ? err.message : String(err)));
  }
}
`
);

// Mark the function directory as ESM so Node.js loads server.js correctly
fs.writeFileSync(
  path.join(funcDir, 'package.json'),
  JSON.stringify({ type: 'module' })
);

// Vercel Node.js Lambda config
fs.writeFileSync(
  path.join(funcDir, '.vc-config.json'),
  JSON.stringify({ handler: 'index.mjs', runtime: 'nodejs22.x', launcherType: 'Nodejs' })
);

// Vercel Output API routing config:
// 1. Serve immutable hashed assets directly
// 2. Fall through to filesystem for static files
// 3. Route everything else to the edge function
fs.writeFileSync(
  path.join(outputDir, 'config.json'),
  JSON.stringify({
    version: 3,
    routes: [
      {
        src: '/_build/(.*)',
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        continue: true,
      },
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/index' },
    ],
  })
);

console.log('✓ Vercel output structure created');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: ${src} does not exist, skipping`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
