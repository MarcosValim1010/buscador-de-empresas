// Enriquecimento de contato (Sprint 3): valida sintaxe de e-mail + MX do
// domínio, e formato de telefone, gravando um score em enrichment_contato.
//
// Só SELECT (leitura) em raw_estabelecimentos + INSERT/UPSERT numa tabela
// nova — não faz ALTER nem toca no schema das tabelas de 72M linhas.
//
// Rodar manualmente na primeira vez com BATCH_SIZE pequeno (ex: 500),
// observando checkpoints/iostat no servidor, antes de aumentar ou agendar
// como job recorrente. Idempotente: se cair no meio, rodar de novo continua
// de onde parou (LEFT JOIN ... IS NULL).
require('dotenv').config();
const { Pool } = require('pg');
const dns = require('dns/promises');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 5,
});

const BATCH_SIZE = parseInt(process.env.ENRICH_BATCH_SIZE || '500', 10);
const UPSERT_CHUNK_SIZE = 500; // linhas por INSERT (evita estourar limite de parâmetros do Postgres)
const DNS_CONCURRENCY = 20;
const PAUSE_BETWEEN_BATCHES_MS = parseInt(process.env.ENRICH_PAUSE_MS || '3000', 10);
const SITUACAO_ATIVA = '02';

// Circuit breaker: a cada N lotes, mede a latência de uma query trivial no
// Postgres. Se estiver alta, pausa e tenta de novo; se continuar alta,
// encerra o script por segurança em vez de continuar gerando carga — mesmo
// sinal (checkpoint/latência degradando) que apareceu manualmente no
// incidente de 2026-08-19, só que monitorado automaticamente ao longo dos
// dias que o job roda sozinho.
const HEALTH_CHECK_EVERY_BATCHES = 20;
const HEALTH_LATENCY_THRESHOLD_MS = 500;
const HEALTH_PAUSE_MS = 60000;

async function checkPgHealth() {
  const start = Date.now();
  await pool.query('SELECT 1');
  return Date.now() - start;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Limita quantas resoluções DNS rodam ao mesmo tempo, para não gerar rajada
// de consultas (mesmo cuidado que motivou este script existir).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function checkMx(dominio, cache) {
  if (cache.has(dominio)) return cache.get(dominio);

  const cached = await pool.query('SELECT tem_mx FROM dominio_mx_cache WHERE dominio = $1', [dominio]);
  if (cached.rows.length) {
    cache.set(dominio, cached.rows[0].tem_mx);
    return cached.rows[0].tem_mx;
  }

  let temMx = false;
  try {
    const records = await dns.resolveMx(dominio);
    temMx = Boolean(records && records.length > 0);
  } catch {
    temMx = false;
  }

  await pool.query(
    `INSERT INTO dominio_mx_cache (dominio, tem_mx) VALUES ($1, $2) ON CONFLICT (dominio) DO NOTHING`,
    [dominio, temMx]
  );
  cache.set(dominio, temMx);
  return temMx;
}

async function processRow(row, domainCache) {
  const { cnpj_basico, cnpj_ordem, cnpj_dv, correio_eletronico, ddd_1, telefone_1 } = row;

  let emailValida = false;
  let mxValido = false;
  if (correio_eletronico) {
    const email = correio_eletronico.trim();
    emailValida = EMAIL_REGEX.test(email);
    if (emailValida) {
      const dominio = email.split('@')[1].toLowerCase();
      mxValido = await checkMx(dominio, domainCache);
    }
  }

  let dddValido = false;
  let formatoValido = false;
  let tipo = 'invalido';
  if (ddd_1 && telefone_1) {
    const parsed = parsePhoneNumberFromString(`+55${ddd_1}${telefone_1}`);
    if (parsed && parsed.isValid()) {
      formatoValido = true;
      dddValido = true;
      tipo = telefone_1.length === 9 ? 'movel' : 'fixo';
    }
  }

  const score = (emailValida ? 0.25 : 0) + (mxValido ? 0.25 : 0) + (formatoValido ? 0.5 : 0);

  return [
    cnpj_basico, cnpj_ordem, cnpj_dv, correio_eletronico,
    emailValida, mxValido, telefone_1, dddValido, formatoValido, tipo, score,
  ];
}

async function upsertChunk(client, rows) {
  const values = rows
    .map((_, i) => {
      const o = i * 11;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
    })
    .join(',');

  await client.query(
    `INSERT INTO enrichment_contato
       (cnpj_basico, cnpj_ordem, cnpj_dv, email_original, email_sintaxe_valida,
        email_dominio_mx_valido, telefone_original, telefone_ddd_valido,
        telefone_formato_valido, telefone_tipo, score_contato)
     VALUES ${values}
     ON CONFLICT (cnpj_basico, cnpj_ordem, cnpj_dv) DO UPDATE SET
       email_original = EXCLUDED.email_original,
       email_sintaxe_valida = EXCLUDED.email_sintaxe_valida,
       email_dominio_mx_valido = EXCLUDED.email_dominio_mx_valido,
       telefone_original = EXCLUDED.telefone_original,
       telefone_ddd_valido = EXCLUDED.telefone_ddd_valido,
       telefone_formato_valido = EXCLUDED.telefone_formato_valido,
       telefone_tipo = EXCLUDED.telefone_tipo,
       score_contato = EXCLUDED.score_contato,
       atualizado_em = now()`,
    rows.flat()
  );
}

async function upsertBatch(rows) {
  const client = await pool.connect();
  try {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      await upsertChunk(client, rows.slice(i, i + UPSERT_CHUNK_SIZE));
    }
  } finally {
    client.release();
  }
}

async function run() {
  const domainCache = new Map();
  let processed = 0;
  let batchCount = 0;
  const startedAt = Date.now();

  console.log(`Iniciando enriquecimento (BATCH_SIZE=${BATCH_SIZE}, pausa=${PAUSE_BETWEEN_BATCHES_MS}ms)`);

  while (true) {
    batchCount++;
    if (batchCount % HEALTH_CHECK_EVERY_BATCHES === 0) {
      const latency = await checkPgHealth();
      if (latency > HEALTH_LATENCY_THRESHOLD_MS) {
        console.error(`ALERTA: latência do Postgres em ${latency}ms, pausando ${HEALTH_PAUSE_MS / 1000}s.`);
        await new Promise((r) => setTimeout(r, HEALTH_PAUSE_MS));
        const retryLatency = await checkPgHealth();
        if (retryLatency > HEALTH_LATENCY_THRESHOLD_MS) {
          console.error(`Latência ainda em ${retryLatency}ms após pausa. Encerrando por segurança (processados: ${processed}).`);
          await pool.end();
          process.exit(1);
        }
        console.log(`Latência normalizada (${retryLatency}ms), retomando.`);
      }
    }

    const { rows } = await pool.query(
      `SELECT e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv, e.correio_eletronico, e.ddd_1, e.telefone_1
       FROM raw_estabelecimentos e
       LEFT JOIN enrichment_contato c
         ON c.cnpj_basico = e.cnpj_basico AND c.cnpj_ordem = e.cnpj_ordem AND c.cnpj_dv = e.cnpj_dv
       WHERE e.situacao_cadastral = $1
         AND c.cnpj_basico IS NULL
       ORDER BY e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv
       LIMIT $2`,
      [SITUACAO_ATIVA, BATCH_SIZE]
    );

    if (rows.length === 0) break;

    const results = await mapWithConcurrency(rows, DNS_CONCURRENCY, (row) => processRow(row, domainCache));
    await upsertBatch(results);

    processed += rows.length;
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`Processados: ${processed} (${elapsedS}s decorridos)`);

    await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_BATCHES_MS));
  }

  console.log(`Concluído. Total processado: ${processed}`);
  await pool.end();
}

run().catch((err) => {
  console.error('Erro no enriquecimento:', err);
  process.exit(1);
});
