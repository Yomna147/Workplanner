import { cpSync, existsSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '../dist');
const publicDir = resolve(__dirname, '../../Back-end/public');

if (!existsSync(distDir)) {
  console.error('dist/ not found. Run "npm run build" first.');
  process.exit(1);
}

cpSync(join(distDir, 'index.html'), join(publicDir, 'index.html'), { force: true });

const assetsDest = join(publicDir, 'assets');
if (existsSync(assetsDest)) {
  rmSync(assetsDest, { recursive: true, force: true });
}
cpSync(join(distDir, 'assets'), assetsDest, { recursive: true });

const faviconSrc = join(distDir, 'favicon.png');
if (existsSync(faviconSrc)) {
  cpSync(faviconSrc, join(publicDir, 'favicon.png'), { force: true });
}

console.log('Deployed Front-end/dist -> Back-end/public');
