import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8080);
export const ENTRY = '/examples/vanilla/diagnostico.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};

function mimeOf(path) {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? null : MIME[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
}

/** Resolve a URL dentro da raiz. Devolve null se escapar dela. */
function safeResolve(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(ROOT, `.${normalize(decoded)}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

function statFile(path) {
  try {
    const info = statSync(path);
    if (info.isDirectory()) {
      const index = join(path, 'index.html');
      return statSync(index).isFile() ? { path: index, size: statSync(index).size } : null;
    }
    return { path, size: info.size };
  } catch {
    return null;
  }
}

function handle(req, res) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const target = safeResolve(pathname);
  const file = target && statFile(target);

  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}`);
    console.log(`404 ${pathname}`);
    return;
  }

  res.writeHead(200, {
    'content-type': mimeOf(file.path),
    'content-length': file.size,
    // Sem isso o Chrome do celular continua servindo o bundle antigo depois de
    // um `npm run build` — a falha mais confusa possível neste fluxo.
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file.path).pipe(res);
  console.log(`200 ${pathname}`);
}

/** Sobe o servidor estático da raiz do repo. Resolve quando já está ouvindo. */
export function startServer({ port = PORT } = {}) {
  return new Promise((ok, fail) => {
    const server = createServer(handle);
    server.once('error', fail);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', fail);
      ok({ server, port });
    });
  });
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map((n) => n.address);
}

// Só como CLI (`npm run serve`). Importado pelo dev-tunnel.mjs, o banner não sai.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer();
  console.log(`\nRaiz servida: ${ROOT}\n`);
  console.log(`  local    http://localhost:${port}${ENTRY}`);
  for (const ip of lanAddresses()) {
    console.log(`  rede     http://${ip}:${port}${ENTRY}  (sem HTTPS: câmera e WebXR bloqueados)`);
  }
  console.log(`\nPara o celular, tudo em um comando só:  npm run mobile\n`);
}
