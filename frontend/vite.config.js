import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Servido em produção sob https://aveudata.com.br/crm/ (subpath, não
  // subdomínio) — sem isso os assets buildados (JS/CSS) seriam referenciados
  // a partir de "/", quebrando quando servidos de dentro de /crm/.
  base: '/crm/',
  plugins: [react()],
  server: {
    port: 5173,
  },
});
