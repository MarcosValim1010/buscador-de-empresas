// seed-enrichment-site.js
// Correção estrutural do Sprint 4: materializa UMA VEZ a fila de empresas
// candidatas (matriz + situação ativa) em enrichment_site, com prioridade já
// calculada e processado=false. Depois disso, o discover-site.js lê dessa
// tabela pequena e indexada por PK, em vez de refazer o JOIN + DISTINCT ON +
// anti-join caro contra raw_empresas/raw_estabelecimentos a cada lote — que
// era o gargalo real (query de ~10min por lote de 500, medido no teste de
// 1.500 empresas), não o crawl em si.
//
// Só SELECT (leitura) em raw_estabelecimentos/raw_empresas + INSERT ...
// ON CONFLICT DO NOTHING em enrichment_site — nunca sobrescreve linhas já
// processadas pelo discover-site.js. Paginação por cnpj_basico (keyset, não
// OFFSET) evita reescanear do início a cada lote. Idempotente: se cair no
// meio, rodar de novo continua da última posição salva no log (ou refaz
// alguns lotes — ON CONFLICT DO NOTHING torna isso inofensivo).
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 5,
  options: '-c max_parallel_workers_per_gather=0',
});

const BATCH_SIZE = parseInt(process.env.SEED_BATCH_SIZE || '2000', 10);
const PAUSE_BETWEEN_BATCHES_MS = parseInt(process.env.SEED_PAUSE_MS || '2000', 10);
const HEALTH_CHECK_EVERY_N_BATCHES = 20;
const PG_LATENCY_ALERT_MS = 500;
const SITUACAO_ATIVA = '02';

// Teto de segurança opcional pra rodadas de teste (0 = sem teto).
const MAX_ROWS = parseInt(process.env.SEED_MAX_ROWS || '0', 10);

// Mesmos critérios de prioridade do discover-site.js — mantidos em sincronia
// manualmente (ambos os scripts são pequenos o bastante pra não justificar
// um módulo compartilhado ainda).
const CAPITAL_SOCIAL_MINIMO = parseFloat(process.env.DISCOVER_CAPITAL_MINIMO || '50000');
const CODIGOS_PORTE_PRIORITARIO = ['03', '05'];
const UF_PRIORITARIAS = ['SP', 'RJ', 'MG', 'RS', 'PR', 'SC', 'BA', 'DF', 'PE', 'CE', 'GO'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkPgHealth() {
  const start = Date.now();
  await pool.query('SELECT 1');
  return Date.now() - start;
}

async function circuitBreakerCheck() {
  const latency = await checkPgHealth();
  if (latency > PG_LATENCY_ALERT_MS) {
    console.error(`ALERTA: latência do Postgres em ${latency}ms, pausando 1min.`);
    await sleep(60000);
    const retry = await checkPgHealth();
    if (retry > PG_LATENCY_ALERT_MS) {
      console.error('Latência ainda alta após pausa. Encerrando script por segurança.');
      await pool.end();
      process.exit(1);
    }
  }
}

const CHECKPOINT_EVERY_N_BATCHES = 20; // mesma cadência do circuit breaker

async function loadCheckpoint() {
  const { rows } = await pool.query('SELECT last_cnpj_basico FROM seed_progress WHERE id = 1');
  return rows.length ? rows[0].last_cnpj_basico || '' : '';
}

async function saveCheckpoint(cursor) {
  await pool.query(
    `INSERT INTO seed_progress (id, last_cnpj_basico, atualizado_em) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET last_cnpj_basico = EXCLUDED.last_cnpj_basico, atualizado_em = now()`,
    [cursor]
  );
}

async function insertBatch(rows) {
  const values = rows
    .map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`)
    .join(',');
  const params = rows.flatMap((r) => [r.cnpj_basico, r.prioridade]);

  await pool.query(
    `INSERT INTO enrichment_site (cnpj_basico, prioridade, processado)
     VALUES ${rows.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2},false)`).join(',')}
     ON CONFLICT (cnpj_basico) DO NOTHING`,
    params
  );
}

async function run() {
  let lastCnpjBasico = await loadCheckpoint();
  let processed = 0;
  let batchCount = 0;
  const startedAt = Date.now();

  console.log(`Iniciando seed de enrichment_site (BATCH_SIZE=${BATCH_SIZE}, pausa=${PAUSE_BETWEEN_BATCHES_MS}ms, teto=${MAX_ROWS || 'nenhum'})`);
  console.log(lastCnpjBasico ? `Retomando do checkpoint: cursor=${lastCnpjBasico}` : 'Sem checkpoint salvo, começando do início.');

  while (true) {
    // Paginação por cnpj_basico (keyset), não OFFSET nem anti-join contra
    // enrichment_site — é isso que torna essa varredura O(tabela) uma vez,
    // em vez de O(tabela × número de lotes) como a query antiga.
    const { rows } = await pool.query(
      `SELECT emp.cnpj_basico,
         CASE
           WHEN emp.porte_empresa = ANY($3) AND COALESCE(emp.capital_social_num,0) >= $4 AND e.uf = ANY($5) THEN 1
           WHEN emp.porte_empresa = ANY($3) AND (COALESCE(emp.capital_social_num,0) >= $4 OR e.uf = ANY($5)) THEN 2
           WHEN emp.porte_empresa = ANY($3) THEN 3
           WHEN COALESCE(emp.capital_social_num,0) >= $4 THEN 4
           ELSE 5
         END AS prioridade
       FROM raw_empresas emp
       JOIN raw_estabelecimentos e
         ON e.cnpj_basico = emp.cnpj_basico
         AND e.identificador_matriz_filial = '1'
       WHERE e.situacao_cadastral = $1
         AND emp.cnpj_basico > $2
       ORDER BY emp.cnpj_basico
       LIMIT $6`,
      [SITUACAO_ATIVA, lastCnpjBasico, CODIGOS_PORTE_PRIORITARIO, CAPITAL_SOCIAL_MINIMO, UF_PRIORITARIAS, BATCH_SIZE]
    );

    if (rows.length === 0) {
      console.log('Fim da tabela. Seed concluído.');
      break;
    }

    await insertBatch(rows);

    lastCnpjBasico = rows[rows.length - 1].cnpj_basico;
    processed += rows.length;
    batchCount++;
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`Lote ${batchCount}: ${rows.length} candidatos, cursor=${lastCnpjBasico}. Total: ${processed} (${elapsedS}s decorridos)`);

    if (batchCount % HEALTH_CHECK_EVERY_N_BATCHES === 0) {
      await circuitBreakerCheck();
    }

    if (batchCount % CHECKPOINT_EVERY_N_BATCHES === 0) {
      await saveCheckpoint(lastCnpjBasico);
    }

    if (MAX_ROWS > 0 && processed >= MAX_ROWS) {
      console.log(`Teto de segurança de ${MAX_ROWS} linhas atingido. Encerrando.`);
      break;
    }

    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  if (lastCnpjBasico) await saveCheckpoint(lastCnpjBasico);

  const totalElapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`--- Resumo: ${processed} candidatos inseridos em ${totalElapsedS}s ---`);

  await pool.end();
}

run().catch(async (err) => {
  console.error('Erro fatal:', err);
  await pool.end();
  process.exit(1);
});
