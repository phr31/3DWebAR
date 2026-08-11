import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY, startServer } from './dev-server.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE = resolve(ROOT, 'packages/webar-frame-viewer/dist/frame-viewer.umd.min.js');
const PORT = Number(process.env.PORT ?? 8080);
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!existsSync(BUNDLE)) {
  die('Bundle UMD não encontrado. Rode `npm run build` e sirva a RAIZ do repositório.');
}

const { server, port } = await startServer({ port: PORT });
console.log(`\nServindo a raiz do repo em http://localhost:${port}`);
console.log('Abrindo o túnel HTTPS (cloudflared)…');

const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

tunnel.on('error', (err) => {
  server.close();
  if (err.code === 'ENOENT') {
    die('cloudflared não está no PATH. Instale com:  winget install --id Cloudflare.cloudflared');
  }
  die(`Falha ao iniciar o cloudflared: ${err.message}`);
});

let announced = false;
// O cloudflared escreve o banner com a URL em stderr, não em stdout.
function watch(chunk) {
  const text = String(chunk);
  const match = announced ? null : text.match(TUNNEL_URL);
  if (match) {
    announced = true;
    console.log('\n────────────────────────────────────────────────────────────');
    console.log('  Abra no celular:');
    console.log(`  ${match[0]}${ENTRY}`);
    console.log('────────────────────────────────────────────────────────────');
    console.log('  URL pública e efêmera: some ao fechar este terminal, e muda');
    console.log('  a cada execução. Ctrl+C encerra servidor e túnel.\n');
  }
}

tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);

tunnel.on('exit', (code) => {
  server.close();
  process.exit(code ?? 0);
});

// Sem isso o cloudflared fica órfão no Windows depois do Ctrl+C.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  tunnel.kill();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);
