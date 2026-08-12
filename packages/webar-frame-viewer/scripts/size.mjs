import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// Orçamento deliberadamente muito abaixo dos 200 KB do critério de aceite:
// falha cedo, antes de um import estático de `three` virar invisível.
// O UMD segue sendo o núcleo imperativo, com o three carregado sob demanda do
// CDN: o limite dele NÃO pode subir. É o sinal de que nada de React, R3F ou
// @react-three/xr vazou para o bundle de <script>.
const BUDGET = {
  'dist/frame-viewer.umd.min.js': 60,
  'dist/index.mjs': 75,
  'dist/core.mjs': 30,
};

let failed = false;

for (const [file, limitKb] of Object.entries(BUDGET)) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    console.log(`FAIL ${file}  (não encontrado)`);
    failed = true;
    continue;
  }
  const gz = gzipSync(raw).length / 1024;
  const ok = gz <= limitKb;
  failed ||= !ok;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${file}  ${(statSync(file).size / 1024).toFixed(1)} KB raw  ` +
      `${gz.toFixed(1)} KB gz  (limite ${limitKb} KB)`,
  );
}

process.exit(failed ? 1 : 0);
