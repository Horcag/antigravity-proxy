import fs from 'node:fs';
import { ServiceUnavailableException } from '@nestjs/common';

let productionPage: string | undefined;

export function getDashboardPage(): string {
  if (productionPage) return productionPage;
  const bundled = new URL('./index.html', import.meta.url);
  if (fs.existsSync(bundled)) {
    productionPage = fs.readFileSync(bundled, 'utf8');
    return productionPage;
  }
  const development = new URL('../../web/dist/index.html', import.meta.url);
  if (fs.existsSync(development)) return fs.readFileSync(development, 'utf8');
  throw new ServiceUnavailableException('Панель управления не собрана. Выполните npm run build.');
}
