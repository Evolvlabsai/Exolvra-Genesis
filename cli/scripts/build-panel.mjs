import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const destination = new URL('../dist/panel/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) {
  copyFileSync(new URL('../panel/' + file, import.meta.url), fileURLToPath(new URL(file, destination)));
}
