// website-enrichment-worker.js
// Fase 8-10 (Website Enrichment): visita os sites já CONFIRMADOS pelo
// Sprint 4 (enrichment_site.site_confirmado = true) e extrai telefone,
// WhatsApp, e-mail e redes sociais via GET + regex — sem API paga, sem IA.
//
// Mesma disciplina de discover-site.js/enrich-contato.js: lotes pequenos,
// circuit breaker de latência do Postgres a cada 20 lotes, idempotente via
// ON CONFLICT, dorme (não encerra) quando a fila esvazia — o Sprint 4 ainda
// pode confirmar mais sites depois.
require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');
const https = require('https');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 5,
  // Mesmo ajuste do discover-site.js/server.js: container do Postgres tem
  // --shm-size de só 64MB, plano paralelo em query com JOIN estoura isso.
  options: '-c max_parallel_workers_per_gather=0',
});

// ---------- Config ----------
const BATCH_SIZE = 500; // literal no SQL abaixo, não parametrizado (pedido explícito)
const PAUSE_BETWEEN_BATCHES_MS = parseInt(process.env.WEBCONTACT_PAUSE_MS || '3000', 10);
const HEALTH_CHECK_EVERY_N_BATCHES = 20;
const PG_LATENCY_ALERT_MS = 500;
const HTTP_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 2;
const MAX_PAGINAS_INTERNAS = 3; // + home = no máximo 4 requests por empresa
const EMPTY_QUEUE_SLEEP_MS = parseInt(process.env.WEBCONTACT_EMPTY_SLEEP_MS || String(30 * 60 * 1000), 10);
// Não pedido explicitamente, mas mesma disciplina do discover-site.js: um
// pequeno espaçamento entre requisições evita rajada de DNS/conexões saindo
// do nosso lado, mesmo sem proxy e mesmo cada empresa sendo um domínio
// diferente (o motivo aqui é proteger nosso próprio processo, não o alvo).
const REQS_PER_SECOND = parseFloat(process.env.WEBCONTACT_REQS_PER_SECOND || '5');
const DELAY_MS = 1000 / REQS_PER_SECOND;

const USER_AGENT = 'CnpjBuscadorBot/1.0 (contato: Marcosestudante762@gmail.com)';

// Slugs de página interna candidata — só seguimos se aparecerem como link
// real na home, nunca adivinhados/forçados (sem crawling além disso).
const SLUGS_PAGINA_INTERNA = ['contato', 'contact', 'sobre', 'quem-somos', 'empresa'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Circuit breaker (igual ao Sprint 3/4) ----------
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

// ---------- HTTP com redirect manual (máx. 2) ----------
async function httpGetRaw(url, timeoutMs) {
  await sleep(DELAY_MS);
  return httpGetRawSemDelay(url, timeoutMs);
}

function httpGetRawSemDelay(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        let data = '';
        let bytesRead = 0;
        const MAX_BYTES = 300_000;
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

async function httpGetComRedirect(url, redirectsRestantes = MAX_REDIRECTS) {
  const res = await httpGetRaw(url, HTTP_TIMEOUT_MS);
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location && redirectsRestantes > 0) {
    const proximaUrl = new URL(res.headers.location, url).toString();
    return httpGetComRedirect(proximaUrl, redirectsRestantes - 1);
  }
  return { ...res, urlFinal: url };
}

// ---------- Extração ----------
const REGEX_TEL_HREF = /href=["']tel:([^"']+)["']/gi;
// Exige separador (espaço/ponto/traço) antes dos 4 últimos dígitos — é assim
// que humanos sempre escrevem telefone ("98765-4321", "3456 7890"), e é
// exatamente isso que falta em sequências de dígitos corridos (código de
// barras, SKU, ID de tracking). Achado real: sem essa exigência, uma única
// página de catálogo (farmácia) gerou 801 "telefones" falsos de números de
// produto — corrigido antes de liberar a fila completa.
const REGEX_TEL_TEXTO = /(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]\d{4}\b/g;
const REGEX_EMAIL_HREF = /href=["']mailto:([^"'?]+)/gi;
const REGEX_EMAIL_TEXTO = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const REGEX_WHATSAPP = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=)(\d+)/gi;
const REGEX_REDE_SOCIAL = /href=["'](https?:\/\/(?:www\.)?(instagram|facebook|linkedin|tiktok|youtube|twitter|x)\.com\/[^"']+)["']/gi;

// E-mails/telefones de placeholder comuns em templates de site — filtro de
// ruído óbvio, não uma lista exaustiva.
const EMAIL_DOMINIOS_INVALIDOS = [
  'exemplo.com', 'example.com', 'seudominio.com', 'seudominio.com.br',
  'dominio.com', 'yourdomain.com', 'wixpress.com', 'sentry.io', 'test.com', 'teste.com',
];
const EMAIL_USUARIOS_INVALIDOS = ['exemplo', 'teste', 'seunome', 'email', 'test', 'user', 'sentry'];

function apenasDigitos(texto) {
  return (texto || '').replace(/\D/g, '');
}

function normalizarTelefoneBr(digitosBrutos) {
  let d = apenasDigitos(digitosBrutos);
  if (d.length < 10 || d.length > 13) return null; // curto/longo demais pra ser telefone BR válido
  if (!d.startsWith('55')) d = `55${d}`;
  if (d.length < 12 || d.length > 13) return null; // 55 + DDD(2) + numero(8 ou 9)
  return d;
}

function emailValido(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e.includes('@')) return false;
  const [usuario, dominio] = e.split('@');
  if (EMAIL_DOMINIOS_INVALIDOS.includes(dominio)) return false;
  if (EMAIL_USUARIOS_INVALIDOS.includes(usuario)) return false;
  return true;
}

function extrairInstagramHandle(url) {
  const m = /instagram\.com\/([a-zA-Z0-9._]+)/i.exec(url);
  if (!m) return null;
  const handle = m[1].replace(/\/$/, '');
  if (!handle || ['p', 'reel', 'explore', 'accounts'].includes(handle.toLowerCase())) return null;
  return `@${handle}`;
}

// Retorna lista de { type, normalized_value, raw_value }, deduplicada dentro
// da própria página (dedupe final entre páginas fica pro chamador).
function extrairContatos(html) {
  const achados = [];
  if (!html) return achados;

  for (const m of html.matchAll(REGEX_TEL_HREF)) {
    const norm = normalizarTelefoneBr(m[1]);
    if (norm) achados.push({ type: 'telefone', normalized_value: norm, raw_value: m[1] });
  }
  for (const m of html.matchAll(REGEX_TEL_TEXTO)) {
    const norm = normalizarTelefoneBr(m[0]);
    if (norm) achados.push({ type: 'telefone', normalized_value: norm, raw_value: m[0] });
  }

  for (const m of html.matchAll(REGEX_EMAIL_HREF)) {
    if (emailValido(m[1])) achados.push({ type: 'email', normalized_value: m[1].trim().toLowerCase(), raw_value: m[1] });
  }
  for (const m of html.matchAll(REGEX_EMAIL_TEXTO)) {
    if (emailValido(m[0])) achados.push({ type: 'email', normalized_value: m[0].trim().toLowerCase(), raw_value: m[0] });
  }

  for (const m of html.matchAll(REGEX_WHATSAPP)) {
    const norm = normalizarTelefoneBr(m[1]);
    if (norm) achados.push({ type: 'whatsapp', normalized_value: norm, raw_value: m[1] });
  }

  for (const m of html.matchAll(REGEX_REDE_SOCIAL)) {
    const urlRede = m[1];
    const rede = m[2].toLowerCase() === 'x' ? 'twitter' : m[2].toLowerCase();
    if (rede === 'instagram') {
      const handle = extrairInstagramHandle(urlRede);
      if (handle) achados.push({ type: 'instagram', normalized_value: handle, raw_value: urlRede });
    } else {
      achados.push({ type: rede, normalized_value: urlRede.replace(/\/$/, '').toLowerCase(), raw_value: urlRede });
    }
  }

  return achados;
}

// Acha, dentro do HTML da home, até MAX_PAGINAS_INTERNAS links reais que
// contenham um dos slugs candidatos — nunca adivinha URL, só segue o que já
// está linkado na própria página.
function acharLinksInternos(html, baseUrl) {
  const encontrados = new Map(); // slug -> url absoluta (1 por slug)
  const baseOrigin = new URL(baseUrl).origin;
  const regexHref = /href=["']([^"']+)["']/gi;

  for (const m of html.matchAll(regexHref)) {
    if (encontrados.size >= MAX_PAGINAS_INTERNAS) break;
    const hrefBruta = m[1].trim();

    // Descarta de cara qualquer coisa que não seja link de página (e-mail,
    // telefone, âncora, JS) — antes eram testadas como string crua e
    // "mailto:contato@..." casava com o slug "contato" por engano.
    if (/^(mailto:|tel:|javascript:|whatsapp:|#)/i.test(hrefBruta)) continue;

    let url;
    try {
      url = new URL(hrefBruta, baseUrl);
    } catch {
      continue; // href relativa quebrada
    }

    // Só páginas do próprio site — isso também descarta de graça os links
    // de rede social (instagram.com, facebook.com etc.), que nunca são
    // "página interna" mesmo que o texto contenha um slug por coincidência
    // (ex.: "instagram.com/empresareal" contém "empresa").
    if (url.origin !== baseOrigin) continue;

    const caminho = url.pathname.toLowerCase();
    for (const slug of SLUGS_PAGINA_INTERNA) {
      if (encontrados.has(slug)) continue;
      if (caminho.includes(slug)) {
        encontrados.set(slug, url.toString());
        break;
      }
    }
  }
  return [...encontrados.values()].slice(0, MAX_PAGINAS_INTERNAS);
}

// ---------- Processamento por empresa ----------
async function processarEmpresa(empresa) {
  const contatos = []; // { type, normalized_value, raw_value, source_url }
  let erro = null;

  let home;
  try {
    home = await httpGetComRedirect(empresa.site_url);
  } catch (e) {
    return { contatos, erro: `home: ${e.message}` };
  }
  if (home.status >= 400) {
    return { contatos, erro: `home: HTTP ${home.status}` };
  }

  for (const c of extrairContatos(home.body)) {
    contatos.push({ ...c, source_url: home.urlFinal });
  }

  let linksInternos = [];
  try {
    linksInternos = acharLinksInternos(home.body, home.urlFinal);
  } catch {
    linksInternos = [];
  }

  for (const url of linksInternos) {
    try {
      const pagina = await httpGetComRedirect(url);
      if (pagina.status < 400) {
        for (const c of extrairContatos(pagina.body)) {
          contatos.push({ ...c, source_url: pagina.urlFinal });
        }
      }
    } catch {
      // página interna falhou — não é erro fatal da empresa, só segue sem ela
    }
  }

  // Dedup por (type, normalized_value) — fica só a primeira página onde apareceu.
  const vistos = new Set();
  const dedupados = [];
  for (const c of contatos) {
    const chave = `${c.type}:${c.normalized_value}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    dedupados.push(c);
  }

  return { contatos: dedupados, erro };
}

// ---------- Persistência ----------
async function salvarContatos(cnpjBasico, contatos) {
  for (const c of contatos) {
    await pool.query(
      `INSERT INTO company_contact
         (cnpj_basico, type, normalized_value, raw_value, source, source_url, confidence, last_seen_at, active)
       VALUES ($1,$2,$3,$4,'WEBSITE',$5,100, now(), true)
       ON CONFLICT (cnpj_basico, type, normalized_value, source) DO UPDATE SET
         last_seen_at = now(),
         active = true,
         source_url = EXCLUDED.source_url`,
      [cnpjBasico, c.type, c.normalized_value, c.raw_value, c.source_url]
    );
  }
}

async function marcarProcessado(cnpjBasico, erro) {
  await pool.query(
    `UPDATE enrichment_site
     SET contato_processado = true, contato_processado_em = now(), contato_ultimo_erro = $2
     WHERE cnpj_basico = $1`,
    [cnpjBasico, erro]
  );
}

// ---------- Loop principal ----------
async function processarLote(empresas) {
  const contagem = { telefone: 0, whatsapp: 0, email: 0, instagram: 0, facebook: 0, linkedin: 0, tiktok: 0, youtube: 0, twitter: 0 };
  const inicioLote = Date.now();
  let feitas = 0;

  for (const empresa of empresas) {
    const { contatos, erro } = await processarEmpresa(empresa);
    if (contatos.length > 0) {
      await salvarContatos(empresa.cnpj_basico, contatos);
      for (const c of contatos) contagem[c.type] = (contagem[c.type] || 0) + 1;
    }
    // Marca processado independente de erro ou de ter achado algo — site sem
    // contato visível é resultado válido, site fora do ar não fica reentrando.
    await marcarProcessado(empresa.cnpj_basico, erro);

    feitas++;
    if (feitas % 10 === 0) {
      const elapsedS = ((Date.now() - inicioLote) / 1000).toFixed(0);
      console.log(`  ... ${feitas}/${empresas.length} no lote atual (${elapsedS}s decorridos)`);
    }
  }

  return contagem;
}

async function run() {
  let processed = 0;
  let batchCount = 0;
  const startedAt = Date.now();

  console.log(`Iniciando website-enrichment-worker (BATCH_SIZE=${BATCH_SIZE}, pausa=${PAUSE_BETWEEN_BATCHES_MS}ms)`);

  while (true) {
    const { rows } = await pool.query(
      `SELECT cnpj_basico, site_url FROM enrichment_site
       WHERE site_confirmado = true AND contato_processado = false
       LIMIT 500`
    );

    if (rows.length === 0) {
      console.log(`Fila de contato vazia por enquanto — dormindo ${EMPTY_QUEUE_SLEEP_MS / 60000}min antes de checar de novo (Sprint 4 pode confirmar mais sites).`);
      await sleep(EMPTY_QUEUE_SLEEP_MS);
      continue;
    }

    const contagem = await processarLote(rows);

    processed += rows.length;
    batchCount++;
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `Lote ${batchCount}: ${rows.length} processadas, ${contagem.telefone} telefones, ${contagem.whatsapp} whatsapp, ` +
      `${contagem.instagram} instagram, ${contagem.email} email, ${contagem.facebook} facebook, ${contagem.linkedin} linkedin ` +
      `encontrados. Total: ${processed} (${elapsedS}s decorridos)`
    );

    if (batchCount % HEALTH_CHECK_EVERY_N_BATCHES === 0) {
      await circuitBreakerCheck();
    }

    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }
}

run().catch(async (err) => {
  console.error('Erro fatal:', err);
  await pool.end();
  process.exit(1);
});
