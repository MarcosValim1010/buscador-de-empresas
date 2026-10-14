// discover-site.js
// Sprint 4 — Descoberta de site institucional (sem LinkedIn, sem redes sociais).
// Segue o mesmo padrão do enrich-contato.js: CommonJS, idempotente via
// LEFT JOIN ... IS NULL, circuit breaker de latência do Postgres, lotes
// pequenos com pausa entre eles.
//
// Só faz: tentativa de domínio a partir do nome da empresa + DNS + robots.txt
// + checagem HTTP simples. NÃO inclui LinkedIn/Instagram (decisão tomada
// deliberadamente fora de escopo).
require('dotenv').config();
const { Pool } = require('pg');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 5,
  // O container do Postgres tem --shm-size de só 64MB (padrão Docker); um
  // plano paralelo na query principal (JOIN + CASE sobre raw_estabelecimentos)
  // estoura esse limite de memória compartilhada mesmo com o host tendo
  // 12GB livres em /dev/shm. Lotes de 75-500 linhas não precisam de
  // paralelismo, então desabilitamos por conexão em vez de mexer na config
  // do container (gerenciado pelo Coolify, mais arriscado de alterar).
  options: '-c max_parallel_workers_per_gather=0',
});

// ---------- Config ----------
const BATCH_SIZE = parseInt(process.env.DISCOVER_BATCH_SIZE || '500', 10);
const PAUSE_BETWEEN_BATCHES_MS = parseInt(process.env.DISCOVER_PAUSE_MS || '3000', 10);
const HEALTH_CHECK_EVERY_N_BATCHES = 20;
const PG_LATENCY_ALERT_MS = 500;
const HTTP_TIMEOUT_MS = 8000;
const SITUACAO_ATIVA = '02'; // confirmado em produção: 28.148.920 linhas

// Fila vazia por falta de trabalho (não por erro) é esperado e recorrente
// enquanto o seed-enrichment ainda está rodando — em vez de encerrar e
// depender de reinício manual, dorme e checa de novo. --no-autorestart e o
// circuit breaker de latência continuam protegendo contra falha real.
const EMPTY_QUEUE_SLEEP_MS = parseInt(process.env.DISCOVER_EMPTY_QUEUE_SLEEP_MS || String(30 * 60 * 1000), 10);

// Teto de segurança pra rodadas de teste em amostra maior: o processo se
// encerra sozinho ao atingir esse número de empresas processadas, em vez de
// continuar até a base toda (0/ausente = sem teto, roda até terminar).
const MAX_COMPANIES = parseInt(process.env.DISCOVER_MAX_COMPANIES || '0', 10);

// Rate limit para checagem de site — mais tolerante que o que seria
// aceitável para o LinkedIn (cada empresa é um domínio diferente na maioria
// dos casos, não é a mesma origem sendo martelada), mas ainda conservador.
// Aplicado a CADA chamada HTTP de saída (robots.txt + site em si), não só
// uma vez por empresa — uma empresa pode gerar várias chamadas (2 sufixos x
// robots + http/https), e só limitar "por empresa" deixaria a taxa real
// mais alta que o nominal.
const REQS_PER_SECOND = parseFloat(process.env.DISCOVER_REQS_PER_SECOND || '3');
const DELAY_MS = 1000 / REQS_PER_SECOND;

const SUFIXOS_TESTAR = ['.com.br', '.com']; // ordem de tentativa

// A prioridade (porte/capital/UF) é calculada uma vez em
// seed-enrichment-site.js ao popular a fila — ver esse arquivo pros
// critérios e ajustes. Este script só lê a coluna já pronta.

// ---------- Circuit breaker (igual ao Sprint 3) ----------
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Estatísticas globais pra identificar padrão de lentidão (ex: timeout
// concentrado em algum tipo de chamada) — impressas no resumo final.
const stats = {
  dnsChecked: 0,
  dnsFound: 0,
  httpAttempts: 0,
  httpTimeouts: 0,
  httpOtherErrors: 0,
  robotsBlocked: 0,
};

// ---------- HTTP helper simples, sem dependência externa ----------
// Único ponto de saída de rede do script — o rate limit é aplicado aqui
// dentro, então toda chamada (robots.txt ou site) respeita o mesmo limite,
// não importa quantas vezes discoverSite() a chame por empresa.
const USER_AGENT = 'CnpjBuscadorBot/1.0 (contato: Marcosestudante762@gmail.com)';

function httpGetRaw(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        let data = '';
        let bytesRead = 0;
        const MAX_BYTES = 200_000;
        res.on('data', (chunk) => {
          bytesRead += chunk.length;
          if (bytesRead < MAX_BYTES) data += chunk;
          if (bytesRead >= MAX_BYTES) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function httpGet(url, timeoutMs = HTTP_TIMEOUT_MS) {
  await sleep(DELAY_MS);
  stats.httpAttempts++;
  try {
    return await httpGetRaw(url, timeoutMs);
  } catch (err) {
    if (err.message === 'timeout') stats.httpTimeouts++;
    else stats.httpOtherErrors++;
    throw err;
  }
}

async function domainHasDns(dominio) {
  stats.dnsChecked++;
  try {
    const records = await dns.resolve4(dominio).catch(() => dns.resolve6(dominio));
    const found = records && records.length > 0;
    if (found) stats.dnsFound++;
    return found;
  } catch {
    return false;
  }
}

// ---------- robots.txt ----------
// Parser simplificado (não é um parser RFC 9309 completo), mas escopado por
// seção de User-agent — a versão original usava um regex "preguiçoso"
// ([\s\S]*?) que podia atravessar de uma seção "User-agent: *" até um
// "Disallow: /" de OUTRO user-agent mais abaixo no arquivo, e tratar isso
// como se fosse regra do "*" (falso bloqueio: sites permitidos sendo
// pulados). Aqui isolamos primeiro o bloco de texto pertencente a
// "User-agent: *" (até a próxima linha "User-agent:" ou o fim do arquivo)
// antes de procurar "Disallow: /" dentro dele.
function isDisallowedForAll(robotsBody) {
  const lines = robotsBody.split(/\r?\n/);
  let inWildcardBlock = false;
  let sawWildcardBlock = false;
  let disallowAll = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const uaMatch = /^User-agent:\s*(.+)$/i.exec(line);
    if (uaMatch) {
      inWildcardBlock = uaMatch[1].trim() === '*';
      if (inWildcardBlock) sawWildcardBlock = true;
      continue;
    }
    if (inWildcardBlock) {
      const disallowMatch = /^Disallow:\s*(.*)$/i.exec(line);
      if (disallowMatch && disallowMatch[1].trim() === '/') {
        disallowAll = true;
      }
    }
  }

  // Sem seção "User-agent: *" explícita, não há regra que nos diga
  // respeito — tratamos como permitido (mesma interpretação da versão
  // original, só que agora com escopo correto).
  return sawWildcardBlock && disallowAll;
}

async function getRobotsPermission(dominio) {
  const cached = await pool.query('SELECT permite_scraping FROM robots_cache WHERE dominio = $1', [dominio]);
  if (cached.rows.length) return cached.rows[0].permite_scraping;

  let permite = true; // default: permite, a menos que robots.txt diga o contrário
  try {
    const res = await httpGet(`https://${dominio}/robots.txt`, 5000);
    if (res.body) {
      permite = !isDisallowedForAll(res.body);
    }
  } catch {
    permite = true; // sem robots.txt acessível, assume permitido
  }

  await pool.query(
    `INSERT INTO robots_cache (dominio, permite_scraping) VALUES ($1, $2) ON CONFLICT (dominio) DO NOTHING`,
    [dominio, permite]
  );
  return permite;
}

// ---------- Descoberta de domínio ----------
// Achado do teste anterior: nome_fantasia de estabelecimento é uma fonte
// ruim de slug quando a empresa tem muitas filiais (ex: bancos usam o nome
// da cidade como nome_fantasia de cada agência) — gerava domínios de
// terceiros por coincidência de nome genérico. razao_social (atributo da
// empresa como um todo, vem de raw_empresas) é bem mais estável e agora é a
// fonte primária; nome_fantasia da matriz fica só como fallback.
function slugify(razaoSocial, nomeFantasia) {
  const base = (razaoSocial || nomeFantasia || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/\s+(ltda|me|epp|eireli|sa|s\/a)\.?$/i, '') // remove sufixo societário mais comum
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '');
  return base;
}

// Primeira palavra "forte" da razão social, ignorando sufixos societários —
// usada como sinal fraco na verificação de conteúdo.
function palavraChaveRazaoSocial(razaoSocial) {
  const limpo = (razaoSocial || '')
    .replace(/\b(LTDA|ME|EPP|EIRELI|SA|S\/A)\b/gi, '')
    .trim();
  return limpo.split(/\s+/)[0] || '';
}

// Verificação de conteúdo (correção do achado com o Banco do Brasil): DNS +
// HTTP 200 sozinhos não confirmam que o domínio é realmente da empresa.
// Depois de achar um candidato respondendo, procuramos no HTML já capturado
// (até 200KB, mesmo limite do httpGet) pelo CNPJ completo (com e sem
// pontuação) — sinal forte — ou pela primeira palavra significativa da
// razão social — sinal fraco, mas ainda reduz falso positivo bruto.
function verificaConteudo(html, cnpjCompleto, razaoSocial) {
  if (!html) return false;
  const cnpjLimpo = cnpjCompleto.replace(/\D/g, '');
  const cnpjFormatado = `${cnpjLimpo.slice(0, 2)}.${cnpjLimpo.slice(2, 5)}.${cnpjLimpo.slice(5, 8)}/${cnpjLimpo.slice(8, 12)}-${cnpjLimpo.slice(12, 14)}`;
  const temCnpj = html.includes(cnpjLimpo) || html.includes(cnpjFormatado);

  const palavraChave = palavraChaveRazaoSocial(razaoSocial);
  const temNomeParcial = palavraChave.length > 3 && html.toUpperCase().includes(palavraChave.toUpperCase());

  return Boolean(temCnpj || temNomeParcial);
}

// AVISO: mesmo com verificação de conteúdo, ainda pode haver falso positivo
// residual em casos raros (ex: outra empresa com nome muito parecido cita o
// termo por coincidência). site_confirmado=true reduz drasticamente o
// risco, mas não é garantia absoluta — tratar como "alta confiança", não
// "fato verificado com certeza".
async function discoverSite(empresa) {
  const slug = slugify(empresa.razao_social, empresa.nome_fantasia);
  if (!slug || slug.length < 3) return null;

  const cnpjCompleto = `${empresa.cnpj_basico}${empresa.cnpj_ordem}${empresa.cnpj_dv}`;

  for (const sufixo of SUFIXOS_TESTAR) {
    const dominio = `${slug}${sufixo}`;

    const temDns = await domainHasDns(dominio);
    if (!temDns) continue;

    const permiteRobots = await getRobotsPermission(dominio);
    if (!permiteRobots) {
      stats.robotsBlocked++;
      console.log(`Robots.txt bloqueia ${dominio}, pulando.`);
      continue;
    }

    let res = null;
    let url = null;
    try {
      url = `https://${dominio}`;
      res = await httpGet(url);
      if (!(res.status >= 200 && res.status < 400)) res = null;
    } catch {
      res = null;
    }
    if (!res) {
      try {
        url = `http://${dominio}`;
        res = await httpGet(url);
        if (!(res.status >= 200 && res.status < 400)) res = null;
      } catch {
        res = null;
      }
    }

    if (res) {
      const confirmado = verificaConteudo(res.body, cnpjCompleto, empresa.razao_social);
      return { url, status: res.status, dominio, confirmado };
    }
  }

  return null;
}

// ---------- Loop principal ----------
async function processBatch(rows) {
  const results = [];
  let doneInBatch = 0;
  const batchStartedAt = Date.now();

  for (const row of rows) {
    const site = await discoverSite(row);
    results.push({
      cnpj_basico: row.cnpj_basico,
      site_url: site ? site.url : null,
      site_status_http: site ? site.status : null,
      site_confirmado: site ? site.confirmado : false,
      prioridade: row.prioridade,
    });

    doneInBatch++;
    if (doneInBatch % 10 === 0) {
      const elapsedS = ((Date.now() - batchStartedAt) / 1000).toFixed(0);
      const encontradosAteAgora = results.filter((r) => r.site_url).length;
      const confirmadosAteAgora = results.filter((r) => r.site_confirmado).length;
      console.log(`  ... ${doneInBatch}/${rows.length} no lote atual (${encontradosAteAgora} encontrados, ${confirmadosAteAgora} confirmados, ${elapsedS}s decorridos no lote)`);
    }
  }

  return results;
}

async function upsertBatch(results) {
  for (const r of results) {
    await pool.query(
      `INSERT INTO enrichment_site
         (cnpj_basico, site_url, site_status_http, site_confirmado,
          site_ultima_verificacao, prioridade, processado)
       VALUES ($1,$2,$3,$4, now(), $5, true)
       ON CONFLICT (cnpj_basico) DO UPDATE SET
         site_url = EXCLUDED.site_url,
         site_status_http = EXCLUDED.site_status_http,
         site_confirmado = EXCLUDED.site_confirmado,
         site_ultima_verificacao = now(),
         prioridade = EXCLUDED.prioridade,
         processado = true,
         atualizado_em = now()`,
      [r.cnpj_basico, r.site_url, r.site_status_http, r.site_confirmado, r.prioridade]
    );
  }
}

async function run() {
  let processed = 0;
  let batchCount = 0;
  let totalEncontrados = 0;
  let totalConfirmados = 0;
  const startedAt = Date.now();

  console.log(`Iniciando descoberta de site (BATCH_SIZE=${BATCH_SIZE}, ${REQS_PER_SECOND} req/s, pausa=${PAUSE_BETWEEN_BATCHES_MS}ms, teto=${MAX_COMPANIES || 'nenhum'})`);

  while (true) {
    // Correção estrutural: a fila de candidatos já foi materializada uma
    // vez em enrichment_site por seed-enrichment-site.js (matriz + situação
    // ativa, prioridade já calculada). Aqui é só um SELECT simples numa
    // tabela pequena com PK em cnpj_basico — nada de JOIN/DISTINCT ON contra
    // as tabelas de 72M/69M linhas a cada lote, que era o gargalo real
    // (~10min por lote de 500 no teste anterior, não o crawl em si).
    // Produção do Sprint 4 (decisão 2026-08-20, restringido no mesmo dia):
    // só prioridade 1 — a fatia 1-2 projetava ~8,6M candidatos (universo
    // maior do que o esperado quando ~48h foi estimado, porque o seed ainda
    // estava no início). Restrito a só prioridade 1 (~777K projetados) pra
    // reduzir o prazo. Ver CHANGELOG.md.
    const fila = await pool.query(
      `SELECT cnpj_basico, prioridade FROM enrichment_site
       WHERE processado = false AND prioridade = 1
       ORDER BY cnpj_basico
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (fila.rows.length === 0) {
      console.log(`Fila de prioridade 1 vazia por enquanto — dormindo ${EMPTY_QUEUE_SLEEP_MS / 60000}min antes de checar de novo (seed-enrichment pode alimentar mais).`);
      await sleep(EMPTY_QUEUE_SLEEP_MS);
      continue;
    }

    // Segunda query, só pros detalhes (razão social/nome fantasia) do lote
    // já selecionado — bounded por BATCH_SIZE, usa os índices de PK
    // existentes em cnpj_basico, não precisa varrer nada.
    const cnpjBasicosDoLote = fila.rows.map((r) => r.cnpj_basico);
    const detalhes = await pool.query(
      `SELECT emp.cnpj_basico, e.cnpj_ordem, e.cnpj_dv, emp.razao_social, e.nome_fantasia
       FROM raw_empresas emp
       JOIN raw_estabelecimentos e
         ON e.cnpj_basico = emp.cnpj_basico
         AND e.identificador_matriz_filial = '1'
       WHERE emp.cnpj_basico = ANY($1)`,
      [cnpjBasicosDoLote]
    );
    const detalhesPorCnpj = new Map(detalhes.rows.map((d) => [d.cnpj_basico, d]));
    const rows = [];
    const orfaos = []; // cnpj_basico na fila sem correspondência mais (ex: situação mudou) — marcar processado, não travar o loop
    for (const f of fila.rows) {
      const d = detalhesPorCnpj.get(f.cnpj_basico);
      if (d) rows.push({ ...d, prioridade: f.prioridade });
      else orfaos.push(f.cnpj_basico);
    }
    if (orfaos.length > 0) {
      await pool.query(
        `UPDATE enrichment_site SET processado = true, atualizado_em = now() WHERE cnpj_basico = ANY($1)`,
        [orfaos]
      );
    }

    if (rows.length === 0) {
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
      continue;
    }

    const results = await processBatch(rows);
    await upsertBatch(results);

    processed += rows.length;
    batchCount++;
    const encontrados = results.filter((r) => r.site_url).length;
    const confirmados = results.filter((r) => r.site_confirmado).length;
    totalEncontrados += encontrados;
    totalConfirmados += confirmados;
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `Lote ${batchCount}: ${rows.length} empresas distintas, ${encontrados} sites encontrados, ${confirmados} confirmados. Total: ${processed} (${elapsedS}s decorridos)`
    );
    console.log(
      `  stats acumuladas: ${REQS_PER_SECOND} req/s alvo, ${stats.httpAttempts} tentativas HTTP, ${stats.httpTimeouts} timeouts (${stats.httpAttempts ? ((stats.httpTimeouts / stats.httpAttempts) * 100).toFixed(1) : '0'}%), ${stats.httpOtherErrors} outros erros`
    );

    if (batchCount % HEALTH_CHECK_EVERY_N_BATCHES === 0) {
      await circuitBreakerCheck();
    }

    if (MAX_COMPANIES > 0 && processed >= MAX_COMPANIES) {
      console.log(`Teto de segurança de ${MAX_COMPANIES} empresas atingido. Encerrando.`);
      break;
    }

    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  const totalElapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log('--- Resumo final ---');
  console.log(`Empresas processadas: ${processed}`);
  console.log(`Tempo total: ${totalElapsedS}s (${(processed / (totalElapsedS || 1)).toFixed(2)} empresas/s)`);
  console.log(`Sites encontrados: ${totalEncontrados} (${((totalEncontrados / processed) * 100).toFixed(1)}%)`);
  console.log(`Sites confirmados: ${totalConfirmados} (${((totalConfirmados / processed) * 100).toFixed(1)}% do total, ${totalEncontrados ? ((totalConfirmados / totalEncontrados) * 100).toFixed(1) : '0'}% dos encontrados)`);
  console.log(`DNS: ${stats.dnsFound}/${stats.dnsChecked} domínios com DNS`);
  console.log(`HTTP: ${stats.httpAttempts} tentativas, ${stats.httpTimeouts} timeouts (${stats.httpAttempts ? ((stats.httpTimeouts / stats.httpAttempts) * 100).toFixed(1) : '0'}%), ${stats.httpOtherErrors} outros erros`);
  console.log(`Robots.txt bloqueou: ${stats.robotsBlocked} domínios`);

  await pool.end();
}

run().catch(async (err) => {
  console.error('Erro fatal:', err);
  await pool.end();
  process.exit(1);
});
