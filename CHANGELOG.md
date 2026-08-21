# Changelog

## 2026-08-20 — Sprint 4: restrição a prioridade 1 + calibração de taxa

### Restrição do universo-alvo: só prioridade 1

A fatia 1-2 (produção iniciada 2026-08-20) projetava um universo final de
~8,6M candidatos conforme o `seed-enrichment` avançava — bem maior que os
710K conhecidos quando a estimativa de "~48h" foi calculada pela primeira
vez. Restrito a **só prioridade 1** pra reduzir o prazo (query em
`discover-site.js` mudou de `prioridade IN (1,2)` para `prioridade = 1`).
Reinício idempotente confirmado — `processado=false` garante que nada do que
já tinha sido feito é reprocessado.

### Calibração de `REQS_PER_SECOND`: teste em 3 estágios

Diferente do caso do LinkedIn (recusado anteriormente por ser scraping contra
termos de uso de uma plataforma específica com detecção de bot como alvo),
aqui o risco é puramente técnico — milhares de domínios de empresas
distintas, não uma plataforma única. Teste em estágios de 3→5→8 req/s,
~500-3000 empresas por estágio, medindo throughput real e taxa de timeout:

| Estágio | Alvo | Throughput real | Timeout | Outros erros |
|---|---|---:|---:|---:|
| 1 | 3 req/s | 2,40/s | 11,3% | 18,3% |
| 2 | 5 req/s | **3,42/s** | **4,9%** | 21,4% |
| 3 | 8 req/s | 3,38/s | 8,3% | 17,3% |

**Achado:** throughput platôs em ~3,4/s entre 5 e 8 req/s — subir o alvo
nominal não traz ganho de velocidade além desse ponto, porque o gargalo real
passou a ser a latência de rede sequencial por empresa (até 4 chamadas HTTP
em série por candidato — 2 sufixos de domínio × robots.txt+site — sem
paralelismo dentro do lote), não mais a taxa configurada. 8 req/s só piorou o
timeout sem ganhar velocidade. **Produção fixada em 5 req/s**
(`DISCOVER_REQS_PER_SECOND=5`), o ponto de melhor throughput com menor taxa
de erro.

### Estimativa revisada (prioridade 1, 2026-08-20)

Proporção real observada: 432.620 de 5.454.000 candidatos semeados até agora
caem em prioridade 1 (**7,93%**) — mais alto que a suposição inicial de
~2,9%. Extrapolando pra base completa (~26,8M ativas): projeção revisada de
**~2,1 milhões** de empresas prioridade 1 no total (bem mais que os ~777K do
primeiro cálculo, feito quando o seed ainda tinha varrido pouco da base).

Com throughput de produção em 3,42/s: **~6,5 dias** restantes a partir de
2026-08-20, considerando esse universo projetado. Essa estimativa deve ser
revisada conforme o `seed-enrichment` avança e a proporção real de
prioridade 1 se consolida.

## 2026-08-19/20 — Sprint 3 (enriquecimento de contato) + Sprint 4 (descoberta de site institucional)

### Decisão: focar o crawl inicial nas fatias de prioridade 1-2, não na base toda

**Contexto:** depois de corrigir o gargalo de query (ver lição técnica abaixo),
medimos o throughput real de crawl isolado: **4,10 empresas/s**, com **3,5% de
sites encontrados e 1,6% confirmados por conteúdo** (teste de 1.500 empresas,
`discover-site-test2`, 2026-08-20). Rodar a base inteira de ~26,8M empresas
ativas nesse ritmo levaria **~76 dias corridos** — e, com essa taxa de
acerto, a maior parte desse tempo seria gasto tentando descobrir sites de
empresas que provavelmente não têm um (`temTelefone`/`temEmail` já filtra
por presença de contato, mas não por presença de site).

**Decisão:** priorizar as fatias 1 e 2 (`enrichment_site.prioridade`, ver
critérios em [seed-enrichment-site.js](backend/seed-enrichment-site.js)) —
empresas de porte maior, capital social relevante e/ou UF de maior atividade
econômica — antes de considerar rodar a base completa. Custo/benefício de
cobrir a base toda nesta fase é desfavorável dado a taxa de acerto observada;
melhor validar/ajustar a heurística de descoberta numa fatia menor e mais
valiosa primeiro.

**Tamanho das fatias** (contagem parcial em 2026-08-20, seed ainda em
andamento — ver histórico de execução pra número final): prioridade 1 ≈
155.794, prioridade 2 ≈ 554.388 candidatos.

### Produção: `discover-site.js` em execução real (prioridade 1-2)

Iniciado em 2026-08-20 como processo PM2 persistente (`discover-site`,
`--no-autorestart`), rodando em paralelo com `seed-enrichment` (ainda
populando a fila) e `enrich-contato` (Sprint 3) — três processos concorrentes
no mesmo servidor. Query de leitura filtrada por `WHERE processado = false
AND prioridade IN (1, 2)`, usando o índice parcial `idx_enrichment_site_fila`
já existente (`EXPLAIN` com parâmetro vinculado confirmado barato antes de
subir, custo ~18.000, sem `Seq Scan`).

Throughput esperado: **~4,10 empresas/s** (medido no teste comparativo
`discover-site-test2`). Estimativa inicial pra fatia parcial conhecida até
agora (710.182 candidatos prioridade 1+2): **~48h**. Esse número só tende a
crescer conforme o `seed-enrichment` avança e alimenta mais candidatos
prioridade 1-2 na fila — os dois processos rodam de forma independente e
idempotente (`discover-site` só lê o que `processado=false`, nunca reprocessa
nada mesmo reiniciando).

Persistência configurada: `pm2 save` inclui `discover-site` e
`seed-enrichment` na lista restaurada em caso de reboot da VM (`systemd`
service `pm2-ubuntu`, configurado no deploy inicial).

### Lição técnica: `EXPLAIN` com literais ≠ plano real com parâmetros vinculados

**O que aconteceu:** ao revisar `discover-site.js`, validei a query principal de
busca de lote rodando `EXPLAIN` com valores escritos à mão
(`ARRAY['03','05']`, etc.), que deu um plano barato (custo ~1.300,
`Incremental Sort`, sem `Seq Scan`). Rodei o teste pequeno (75-150 empresas) e
funcionou rápido, então segui em frente. No teste maior (1.500 empresas), cada
lote de 500 passou a levar **~10 minutos**, e um `EXPLAIN ANALYZE` da query
real revelou a causa: o Postgres escolheu um plano **completamente
diferente** — `Nested Loop` fazendo 69,5 milhões de buscas de índice, `Sort`
de 26,8 milhões de linhas espalhando 1,9GB pra disco (`external merge`).
Tempo real: 523s por execução.

**Causa raiz:** a aplicação (via `node-postgres`) manda essa query com
`ARRAY[...]` como **parâmetro vinculado** (`$3`, `$4`, `$5`), não como
literal. Pra filtros por igualdade em coluna indexada, isso quase nunca
importa — mas pra `= ANY($array)` combinado com `ORDER BY`/`LIMIT` em cima
de um `JOIN` grande, o Postgres estima a seletividade do array de forma
muito pior sem conhecer o valor real em tempo de planejamento, e pode
escolher uma estratégia de join/sort completamente diferente (e ordens de
magnitude mais cara) do que com o valor literal na mão.

**Como evitar da próxima vez:** ao validar uma query nova com `EXPLAIN` antes
de rodar em produção, testar com a **vinculação real de parâmetro** (via
`client.query(sql, params)` no mesmo driver que a aplicação usa), não só com
literais escritos à mão no SQL — principalmente quando a query tem `= ANY($n)`
sobre um array, combinado com `JOIN`+`ORDER BY`+`LIMIT`. Um script simples
rodando `EXPLAIN` via `pg` (não via `psql` com valores hardcoded) já expõe o
plano real que a aplicação vai receber.

**Correção estrutural aplicada:** em vez de recalcular o `JOIN`+`DISTINCT ON`
a cada lote (o padrão que disparava esse problema), criado
[seed-enrichment-site.js](backend/seed-enrichment-site.js) — materializa a
fila de candidatos (matriz + situação ativa, prioridade já calculada) UMA VEZ
em `enrichment_site`, via paginação por `cnpj_basico` (keyset, não `OFFSET`
nem anti-join). `discover-site.js` passou a ler dessa tabela pequena e
indexada por PK (`SELECT ... WHERE processado=false ORDER BY cnpj_basico
LIMIT N`) — trivial mesmo com parâmetro vinculado, porque não tem mais
array nenhum no caminho de leitura do crawler.

## 2026-08-18/19 — Deploy inicial + performance + incidente de I/O

### Deploy
- Projeto publicado em `152.67.51.117` (Oracle Cloud, ARM, 4 vCPU/24GB RAM), backend na porta 3001 (PM2 `cnpj-api`), frontend buildado servido na porta 5173 (PM2 `cnpj-frontend`, via `serve`).
- Node.js 20 LTS instalado no servidor (não vinha por padrão).
- Boot volume expandido de 47GB → 100GB (o banco já ocupava 36GB e travou a criação de índices por falta de espaço).
- Portas 3001/5173 liberadas na Security List da VCN e no iptables local do servidor.
- Postgres roda em Docker (`postgres:18-alpine`, gerenciado pelo Coolify já instalado na VM) — **não é uma máquina dedicada**, compartilha recursos com Coolify/Traefik/nginx.

### Performance
- `/api/search`: contagem de resultados deixou de ser `COUNT(*)` exato (varria a tabela toda em filtros amplos) e passou a ser limitada a 50.000, com aviso "50.000+" no front quando ultrapassa.
- Busca por nome (`razaoSocial`) reestruturada para bater índice trigram por tabela em vez de forçar `JOIN` completo de 72M×69M linhas antes de filtrar.
- Adicionados índices GIN trigram (`pg_trgm`) em `razao_social` (raw_empresas) e `nome_fantasia` (raw_estabelecimentos).
- `work_mem` 4MB→128MB e `effective_cache_size` 4GB→16GB (estavam no padrão genérico do Postgres, servidor tem RAM sobrando).
- Timeout de 15s nas queries de busca, com mensagem amigável pedindo pra refinar quando o termo é genérico demais (ex: "Silva" bate ~3,2M empresas — sem stack de busca textual dedicada, não dá pra responder rápido).
- `/api/ufs` trocado de `SELECT DISTINCT uf FROM raw_estabelecimentos` (forçava Seq Scan na tabela inteira, baixa seletividade) para lista fixa no código — as UFs do Brasil praticamente não mudam.

### Integridade de dados / schema
- `raw_empresas`: removida 1 linha "fantasma" (razao_social vazia, natureza_juridica='0000') que duplicava `cnpj_basico='08314885'` — era lixo isolado de importação, não um padrão sistêmico (confirmado).
- `UNIQUE (cnpj_basico)` em `raw_empresas` e `UNIQUE (cnpj_basico, cnpj_ordem, cnpj_dv)` em `raw_estabelecimentos` (confirmado sem duplicatas antes de aplicar). Habilita UPSERT nas atualizações semanais da RFB em vez de reload completo da tabela.
- `raw_empresas.capital_social_num` (NUMERIC, coluna gerada) + índice — antes `capital_social` era TEXT com vírgula decimal ("9000,00"), ordenação/filtro numérico quebravam silenciosamente.
- Função `parse_yyyymmdd(text) RETURNS date IMMUTABLE` criada para converter datas "YYYYMMDD" com segurança (trata formato inválido e datas de calendário impossíveis como NULL). Usada para as colunas de data de `raw_estabelecimentos` — **ver incidente abaixo**.

### Segurança
- Porta 5432 (Postgres) estava exposta publicamente na internet e sendo varrida por bots (tentativas de login/protocolo inválido nos logs). Bloqueada via `iptables` na chain `DOCKER-USER` (as portas publicadas pelo Docker contornam o `INPUT` chain normal, usam FORWARD/NAT — descoberto durante este trabalho). App continua funcionando pois conecta via `localhost`.

### Incidente — site fora do ar por I/O saturado (2026-08-19)
**O que aconteceu:** tentativa de adicionar `data_inicio_atividade_date` e `data_situacao_cadastral_date` em `raw_estabelecimentos` (72M linhas) via `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`. Esse comando reescreve a tabela inteira numa única transação com lock — em 72M linhas isso é uma escrita massiva e monolítica. A conexão SSH caiu no meio do processo (~1h rodando), o Postgres detectou e fez rollback automático (nada corrompido), mas a carga de I/O gerada saturou o throughput provisionado do disco (Block Volume "10 VPUs/GB Balanced" = 6.000 IOPS / 48MB/s fixos — Oracle não usa modelo de crédito de burst como AWS EBS). Checkpoints do Postgres passaram a levar 100-270s (normal é <1s), e o site ficou de fato fora do ar/muito lento por várias horas até a fila de I/O esvaziar.

**Causa raiz:** o padrão errado foi combinar `ADD COLUMN` + `GENERATED...STORED` num único comando monolítico, não a lógica da função de parsing.

**Correção confirmada:** sistema voltou ao normal (`SELECT 1` em 52ms, checkpoints rápidos) assim que a carga parou — não foi necessário esperar "recarga de crédito" (não existe nesse modelo de disco), só o dreno da fila.

**Pendente:** as colunas de data em `raw_estabelecimentos` continuam sem ser adicionadas. Estratégia definida para quando retomar (ver `backend/indices.sql`):
1. `ADD COLUMN` simples sem `GENERATED`/`DEFAULT` (é só metadado, instantâneo, não reescreve a tabela)
2. Preencher via `UPDATE` em lotes pequenos (200-500k linhas por vez, com `ctid`), monitorando checkpoint/iostat ao vivo e parando se degradar
3. `CREATE INDEX CONCURRENTLY` no final (não trava a tabela)
4. Fazer isso fora de horário de pico, sozinho (nunca em paralelo com outra operação pesada na mesma tabela)

### Decisão registrada — Meilisearch
Avaliado adicionar Meilisearch para busca por nome instantânea mesmo em termos genéricos ("Silva"). **Decisão: adiar.** Dois motivos:
1. Risco de I/O — a VM já demonstrou ser sensível a picos de escrita sustentados; indexação inicial de 70M+ registros geraria mais carga no mesmo disco.
2. Ponto único de falha — rodar o índice de busca na mesma VM/disco que serve produção significa que um problema de indexação derruba search *e* site juntos. Quando for retomado, avaliar rodar em VM/disco separado para isolar esse risco.

Retomar colunas de data e Meilisearch em dias separados, um de cada vez, para isolar a causa caso algo dê errado de novo.
