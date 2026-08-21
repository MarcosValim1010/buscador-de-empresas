# Buscador de Empresas — CNPJ

Sistema web interno para filtrar a base de CNPJs (Receita Federal) e exportar
os resultados em planilha Excel.

## Estrutura

```
cnpj-buscador/
├── backend/     API Express (Node.js) que consulta o Postgres
└── frontend/    Interface React (Vite)
```

## 1. Rode os índices no Postgres (uma vez só)

No servidor, via SSH:

```bash
psql -h localhost -U postgres -d cnpj -f backend/indices.sql
```

Isso pode levar alguns minutos (72 milhões de linhas). É necessário para os
filtros responderem rápido.

## 2. Suba o backend

```bash
cd backend
cp .env.example .env
nano .env   # ajuste PGPASSWORD com a senha real do Postgres
npm install
npm start
```

A API sobe na porta `3001` por padrão. Teste com:

```bash
curl http://localhost:3001/api/ufs
```

Para deixar rodando permanentemente (sobrevive a reinícios e desconexões
SSH), use PM2:

```bash
npm install -g pm2
pm2 start server.js --name cnpj-api
pm2 save
pm2 startup   # siga a instrução que ele imprimir
```

**Libere a porta 3001** no firewall (mesmo processo já feito para 8000 e
5432 — Security List da Oracle + iptables):

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save
```

E no console da Oracle: Networking → VCN → Subnet → Security List →
Add Ingress Rule → porta 3001, TCP, 0.0.0.0/0.

## 3. Suba o frontend

Em outra pasta/terminal (pode ser na mesma máquina):

```bash
cd frontend
cp .env.example .env
nano .env   # ajuste VITE_API_URL para http://SEU_IP_PUBLICO:3001
npm install
npm run build
```

Isso gera a pasta `dist/` com os arquivos estáticos prontos. Para servir:

```bash
npm install -g serve
serve -s dist -l 5173
```

Ou, se preferir manter tudo com PM2:

```bash
pm2 start "serve -s dist -l 5173" --name cnpj-frontend
pm2 save
```

Libere a porta 5173 também (mesmo processo do passo anterior).

Acesse: `http://SEU_IP_PUBLICO:5173`

## Alternativa: deploy via Coolify

Como você já tem o Coolify rodando no servidor, dá para publicar os dois
(backend e frontend) como "Applications" separadas, apontando para pastas
locais ou um repositório Git, em vez de rodar `npm start` manualmente. Isso
facilita atualizações futuras (redeploy com um clique) e evita depender do
PM2. Se quiser seguir esse caminho, é só pedir o passo a passo.

## Notas sobre os dados

- A exportação está limitada a 100.000 linhas por vez (arquivo `server.js`,
  constante `EXPORT_MAX_ROWS`) para não estourar memória do servidor.
  Refine os filtros (UF + CNAE + situação) para ficar abaixo disso, ou peça
  ajuda para implementar exportação em lotes/paginada se precisar de mais.
- O filtro "Somente com telefone" considera vazio qualquer `ddd_1` igual a
  `'0'`, `''` ou nulo — é assim que a Receita marca "sem telefone
  cadastrado" nos dados abertos.
- Situação cadastral "Ativa" (código 02) vem marcada por padrão ao abrir a
  tela, já que normalmente é o que interessa para prospecção.
