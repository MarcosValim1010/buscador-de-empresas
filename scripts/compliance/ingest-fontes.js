// ingest-fontes.js — Sprint C2: ingestão real em compliance_fontes_raw.
//
// TCU Licitantes Inidôneos NÃO está incluído (decisão 2026-08-24): a
// listagem real está atrás de captcha (codigoVerificacao), que é uma
// barreira deliberada contra automação — não contornamos isso. Só
// CEIS/CNEP/CEAF, via API oficial com chave.
//
// Por padrão roda um TESTE PEQUENO (poucas páginas por fonte) — ver
// INGEST_PAGINAS_POR_FONTE. Aumentar só depois de confirmar a amostra.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { sanitizarPayload, normalizarCnpj, parseDataBr } = require('./utils');

const envPath = path.join(__dirname, '../../backend/.env');
if (fs.existsSync(envPath)) {
  for (const linha of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(linha.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const API_KEY = process.env.PORTAL_TRANSPARENCIA_API_KEY;
if (!API_KEY) {
  console.error('PORTAL_TRANSPARENCIA_API_KEY não definida no .env. Abortando.');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 5,
  options: '-c max_parallel_workers_per_gather=0',
});

const BASE_URL = 'https://api.portaldatransparencia.gov.br/api-de-dados';
// Teste pequeno por padrão — não é a ingestão completa. Ajustar via env só
// depois de revisar a amostra gravada.
const PAGINAS_POR_FONTE = parseInt(process.env.INGEST_PAGINAS_POR_FONTE || '2', 10);
const PAUSA_ENTRE_PAGINAS_MS = 500;

const HOJE = new Date();
const DATA_FINAL = formatarData(HOJE);
const DATA_INICIAL = formatarData(new Date(HOJE.getFullYear() - 10, HOJE.getMonth(), HOJE.getDate()));

function formatarData(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function consultarPagina(caminho, paramsExtra, pagina) {
  const url = new URL(`${BASE_URL}/${caminho}`);
  Object.entries({ ...paramsExtra, pagina }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'chave-api-dados': API_KEY, Accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status };
  const body = await res.json().catch(() => []);
  return { ok: true, rows: Array.isArray(body) ? body : [] };
}

// Extrai os campos normalizados de compliance_fontes_raw a partir de um
// registro bruto de CEIS/CNEP/CEAF — o "codigoFormatado" de `sancionado` é a
// fonte mais confiável de CNPJ/CPF (presente em todos), mas já sai
// sanitizado (mascarando CPF) antes de qualquer gravação.
function extrairCampos(registro, fonte) {
  const codigoBruto = registro?.sancionado?.codigoFormatado || registro?.punicao?.cpfPunidoFormatado || '';
  const tipoPessoa = registro?.pessoa?.tipo === 'Pessoa Física' ? 'PF' : 'PJ';
  const nome = registro?.sancionado?.nome || registro?.punicao?.nomePunido || registro?.pessoa?.nome || '';

  const motivo = registro?.tipoSancao?.descricaoResumida
    || registro?.tipoPunicao?.descricao
    || (registro?.fundamentacao?.[0]?.codigo ?? '');

  const dataInicio = parseDataBr(registro?.dataInicioSancao) || parseDataBr(registro?.dataPublicacao);
  const dataFim = parseDataBr(registro?.dataFimSancao);

  return {
    fonte,
    cnpj_cpf_raw: sanitizarPayload(codigoBruto),
    nome_razao_social: nome,
    tipo_pessoa: tipoPessoa,
    motivo_sancao: motivo,
    data_inicio_sancao: dataInicio,
    data_fim_sancao: dataFim,
    detalhe_original: sanitizarPayload(registro),
  };
}

async function inserirRegistro(campos) {
  await pool.query(
    `INSERT INTO compliance_fontes_raw
       (fonte, cnpj_cpf_raw, nome_razao_social, tipo_pessoa, motivo_sancao,
        data_inicio_sancao, data_fim_sancao, detalhe_original)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      campos.fonte,
      campos.cnpj_cpf_raw,
      campos.nome_razao_social,
      campos.tipo_pessoa,
      campos.motivo_sancao,
      campos.data_inicio_sancao,
      campos.data_fim_sancao,
      JSON.stringify(campos.detalhe_original),
    ]
  );
}

async function ingerirFonte(nomeFonte, caminho, paramsExtra) {
  let total = 0;
  for (let pagina = 1; pagina <= PAGINAS_POR_FONTE; pagina++) {
    const r = await consultarPagina(caminho, paramsExtra, pagina);
    if (!r.ok) {
      console.log(`${nomeFonte} página ${pagina}: HTTP ${r.status}, parando essa fonte.`);
      break;
    }
    if (r.rows.length === 0) {
      console.log(`${nomeFonte} página ${pagina}: sem mais registros.`);
      break;
    }
    for (const registro of r.rows) {
      const campos = extrairCampos(registro, nomeFonte);
      await inserirRegistro(campos);
      total++;
    }
    console.log(`${nomeFonte} página ${pagina}: ${r.rows.length} registros inseridos.`);
    await sleep(PAUSA_ENTRE_PAGINAS_MS);
  }
  console.log(`${nomeFonte}: total inserido = ${total}`);
  return total;
}

async function main() {
  console.log(`Ingestão de teste — ${PAGINAS_POR_FONTE} página(s) por fonte (CEIS/CNEP/CEAF, sem TCU).`);

  await ingerirFonte('CEIS', 'ceis', { dataInicialSancao: DATA_INICIAL, dataFinalSancao: DATA_FINAL });
  await ingerirFonte('CNEP', 'cnep', { dataInicialSancao: DATA_INICIAL, dataFinalSancao: DATA_FINAL });
  await ingerirFonte('CEAF', 'ceaf', { dataPublicacaoInicio: DATA_INICIAL, dataPublicacaoFim: DATA_FINAL });

  console.log('\nIngestão de teste concluída.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Erro na ingestão:', err);
  await pool.end();
  process.exit(1);
});
