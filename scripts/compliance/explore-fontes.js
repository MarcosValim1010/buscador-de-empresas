// explore-fontes.js — Sprint C1 (exploração, sem ingestão de produção).
//
// Consulta uma amostra pequena de CEIS/CNEP/CEAF na API do Portal da
// Transparência (dados abertos, https://portaldatransparencia.gov.br/api-de-dados)
// pra revisar o formato real de resposta (CNPJ/CPF, motivo, datas) antes de
// definir a lógica de matching e rodar qualquer ingestão de produção.
//
// Não grava nada no banco — só imprime as amostras no console.
// Carrega o .env do backend manualmente (sem depender do pacote dotenv, que
// só está instalado em backend/node_modules, não neste script fora dali).
const fs = require('fs');
const path = require('path');
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

const BASE_URL = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const AMOSTRA_TAMANHO = 8;

// Fallback de filtro de data — CEIS/CNEP/CEAF costumam exigir pelo menos um
// parâmetro de busca; sem CNPJ/CPF específico, usamos um período amplo só
// pra puxar uma amostra genérica de exploração.
const HOJE = new Date();
const DATA_FINAL = formatarData(HOJE);
const DATA_INICIAL = formatarData(new Date(HOJE.getFullYear() - 10, HOJE.getMonth(), HOJE.getDate()));

function formatarData(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function consultar(caminho, params) {
  const url = new URL(`${BASE_URL}/${caminho}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: { 'chave-api-dados': API_KEY, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function resumir(label, resultado) {
  console.log(`\n=== ${label} ===`);
  console.log(`HTTP ${resultado.status}`);
  if (!Array.isArray(resultado.body)) {
    console.log('Resposta (não é array):', JSON.stringify(resultado.body, null, 2).slice(0, 1000));
    return;
  }
  console.log(`Registros retornados nesta página: ${resultado.body.length}`);
  const amostra = resultado.body.slice(0, AMOSTRA_TAMANHO);
  console.log(JSON.stringify(amostra, null, 2));
}

async function explorarCeis() {
  // Sem filtro específico primeiro; se der 400, cai pro filtro de período.
  let r = await consultar('ceis', { pagina: 1 });
  if (r.status !== 200) {
    console.log('CEIS sem filtro deu', r.status, '— tentando com período amplo.');
    r = await consultar('ceis', { dataInicialSancao: DATA_INICIAL, dataFinalSancao: DATA_FINAL, pagina: 1 });
  }
  resumir('CEIS (Cadastro de Empresas Inidôneas e Suspensas)', r);
}

async function explorarCnep() {
  let r = await consultar('cnep', { pagina: 1 });
  if (r.status !== 200) {
    console.log('CNEP sem filtro deu', r.status, '— tentando com período amplo.');
    r = await consultar('cnep', { dataInicialSancao: DATA_INICIAL, dataFinalSancao: DATA_FINAL, pagina: 1 });
  }
  resumir('CNEP (Cadastro Nacional de Empresas Punidas)', r);
}

async function explorarCeaf() {
  // CEAF só aceita cpfSancionado (não CNPJ) — é sobre expulsão de servidor
  // público, pessoa física. Sem CPF específico, tenta por período.
  let r = await consultar('ceaf', { dataPublicacaoInicio: DATA_INICIAL, dataPublicacaoFim: DATA_FINAL, pagina: 1 });
  resumir('CEAF (Cadastro de Expulsões da Administração Federal)', r);
}

async function main() {
  console.log(`Explorando Portal da Transparência (período de fallback: ${DATA_INICIAL} a ${DATA_FINAL})`);
  await explorarCeis();
  await explorarCnep();
  await explorarCeaf();
  console.log('\nExploração concluída. Nada foi gravado no banco.');
}

main().catch((err) => {
  console.error('Erro na exploração:', err);
  process.exit(1);
});
