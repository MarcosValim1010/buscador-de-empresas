// fix-mojibake-encoding.js — corrige mojibake (UTF-8 lido como Latin-1) nas
// tabelas raw_* importadas da Receita Federal.
//
// Causa: em algum import anterior ao atual cnpj_importer.py (que já declara
// ENCODING 'LATIN1' corretamente), os CSVs Latin-1 da RFB foram lidos como
// UTF-8, gerando o clássico "ServiÃ§os advocatÃ­cios" em vez de "Serviços
// advocatícios". Confirmado via hex dump em produção (2026-09-04): é
// corrupção de UMA rodada só (Latin-1 lido como UTF-8), reversível com
//   convert_from(convert_to(col, 'LATIN1'), 'UTF8')
//
// Detecção segura: NÃO usamos `col ~ 'Ã'` puro, porque "Ã"/"Â" também
// aparecem como letras portuguesas legítimas sozinhas (ex: "ALEMÃ",
// "IRMÃ"). O marcador real de mojibake é "Ã" ou "Â" (os únicos lead-bytes
// UTF-8 possíveis pra Latin-1 Supplement, C3/C2) IMEDIATAMENTE seguido de um
// caractere no intervalo U+0080–U+00BF (o "byte de continuação" reinterpretado
// como Latin-1) — isso não ocorre em texto português normal.
const MOJIBAKE_RE = String.raw`[ÃÂ][\x80-\xBF]`;

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const envPath = path.join(__dirname, '../backend/.env');
if (fs.existsSync(envPath)) {
  for (const linha of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(linha.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 3,
  // Sem isso, o Postgres em Docker deste projeto (64MB de shm) já travou
  // antes com parallel workers em queries pesadas (ver CHANGELOG 2026-08-18/19).
  options: '-c max_parallel_workers_per_gather=0',
});

// Tabelas pequenas de referência — corrigidas de uma vez só (poucas linhas).
const TABELAS_PEQUENAS = [
  { table: 'raw_cnaes', columns: ['descricao'] },
  { table: 'raw_naturezas', columns: ['descricao'] },
  { table: 'raw_qualificacoes', columns: ['descricao'] },
  { table: 'raw_paises', columns: ['descricao'] },
  // raw_municipios e raw_motivos: confirmado limpas no diagnóstico, não incluídas.
];

// Tabelas grandes — corrigidas em lotes pequenos via ctid, uma coluna por vez.
const TABELAS_GRANDES = [
  { table: 'raw_empresas', columns: ['razao_social'] },
  {
    table: 'raw_estabelecimentos',
    columns: ['nome_fantasia', 'logradouro', 'bairro', 'complemento'],
  },
  { table: 'raw_socios', columns: ['nome_socio_razao_social', 'nome_representante'] },
];

const BATCH_SIZE = parseInt(process.env.FIX_BATCH_SIZE || '20000', 10);
const PAUSA_ENTRE_LOTES_MS = parseInt(process.env.FIX_BATCH_PAUSE_MS || '500', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function contarAfetadas(table, column) {
  const { rows } = await pool.query(
    `SELECT count(*) FROM "${table}" WHERE "${column}" ~ $1`,
    [MOJIBAKE_RE]
  );
  return parseInt(rows[0].count, 10);
}

async function amostra(table, column, n = 5) {
  const { rows } = await pool.query(
    `SELECT "${column}" AS antes,
            convert_from(convert_to("${column}", 'LATIN1'), 'UTF8') AS depois
     FROM "${table}" WHERE "${column}" ~ $1 LIMIT $2`,
    [MOJIBAKE_RE, n]
  );
  return rows;
}

// Corrige uma coluna em uma tabela pequena, de uma vez (sem batching).
async function corrigirTabelaPequena(table, column, apply) {
  const total = await contarAfetadas(table, column);
  console.log(`\n${table}.${column}: ${total} linha(s) afetada(s)`);
  if (total === 0) return;

  const amostras = await amostra(table, column, 5);
  for (const { antes, depois } of amostras) {
    console.log(`  "${antes}" -> "${depois}"`);
  }

  if (!apply) {
    console.log('  (dry-run — nada gravado; rode com --apply pra aplicar)');
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE "${table}"
     SET "${column}" = convert_from(convert_to("${column}", 'LATIN1'), 'UTF8')
     WHERE "${column}" ~ $1`,
    [MOJIBAKE_RE]
  );
  console.log(`  OK — ${rowCount} linha(s) corrigida(s).`);
}

// Blocos de página física por lote (tabelas grandes). 8192 bytes/página (padrão
// Postgres) * 5000 páginas = ~40MB por lote — bem abaixo do throughput fixo do
// Block Volume (48MB/s) documentado no incidente de I/O anterior.
const BLOCOS_POR_LOTE = parseInt(process.env.FIX_BLOCKS_PER_BATCH || '5000', 10);

// Corrige uma coluna em uma tabela grande, percorrendo a tabela UMA ÚNICA VEZ
// em faixas de ctid por bloco físico (não por LIMIT/OFFSET repetido — repetir
// "WHERE col ~ regex LIMIT N" a cada lote reescaneia do início toda vez pra
// achar as próximas N linhas que ainda não foram corrigidas, o que pode gerar
// I/O de leitura repetido e caro em colunas com muitas linhas afetadas
// espalhadas pela tabela inteira, como bairro/logradouro aqui). Faixas de
// ctid por bloco garantem que cada página do disco é lida uma vez só, no
// total, ao longo de todos os lotes.
async function corrigirTabelaGrande(table, column, apply) {
  const totalInicial = await contarAfetadas(table, column);
  console.log(`\n${table}.${column}: ~${totalInicial} linha(s) afetada(s)`);
  if (totalInicial === 0) return;

  const amostras = await amostra(table, column, 5);
  for (const { antes, depois } of amostras) {
    console.log(`  "${antes}" (len ${antes.length}) -> "${depois}" (len ${depois.length})`);
  }

  if (!apply) {
    console.log('  (dry-run — nada gravado; rode com --apply pra aplicar em lotes)');
    return;
  }

  const { rows: relRows } = await pool.query(
    `SELECT pg_relation_size($1::regclass) / current_setting('block_size')::bigint AS max_block`,
    [table]
  );
  const maxBlock = parseInt(relRows[0].max_block, 10);
  console.log(`  tabela tem ~${maxBlock} páginas; processando em faixas de ${BLOCOS_POR_LOTE} páginas`);

  let totalCorrigido = 0;
  let lote = 0;
  for (let inicio = 0; inicio <= maxBlock; inicio += BLOCOS_POR_LOTE) {
    lote++;
    const fim = inicio + BLOCOS_POR_LOTE;
    const { rowCount } = await pool.query(
      `UPDATE "${table}" SET "${column}" = convert_from(convert_to("${column}", 'LATIN1'), 'UTF8')
       WHERE ctid >= $1::tid AND ctid < $2::tid AND "${column}" ~ $3`,
      [`(${inicio},0)`, `(${fim},0)`, MOJIBAKE_RE]
    );
    totalCorrigido += rowCount;
    if (rowCount > 0) {
      console.log(`  lote ${lote}/${Math.ceil(maxBlock / BLOCOS_POR_LOTE)} (páginas ${inicio}-${fim}): ${rowCount} corrigida(s) (total: ${totalCorrigido})`);
    }
    await sleep(PAUSA_ENTRE_LOTES_MS);
  }
  console.log(`  OK — ${totalCorrigido} linha(s) corrigida(s) em ${lote} lote(s) (esperado: ~${totalInicial}).`);

  // Passe de verificação: em tabela com escrita concorrente (ex: workers de
  // enriquecimento mexendo em outras colunas da mesma linha), uma linha pode
  // ganhar um ctid novo (MVCC) e "fugir" da faixa que o scan já tinha
  // passado. Residual costuma ser pouquíssimas linhas — corrige direto, sem
  // precisar de batching.
  const residual = await contarAfetadas(table, column);
  if (residual > 0) {
    console.log(`  aviso: ${residual} linha(s) ainda afetada(s) após o scan (provável corrida com escrita concorrente) — corrigindo residual...`);
    const { rowCount } = await pool.query(
      `UPDATE "${table}" SET "${column}" = convert_from(convert_to("${column}", 'LATIN1'), 'UTF8') WHERE "${column}" ~ $1`,
      [MOJIBAKE_RE]
    );
    console.log(`  residual corrigido: ${rowCount} linha(s).`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const soGrandes = args.includes('--only-large');
  const soPequenas = args.includes('--only-small');

  console.log(`Regex de detecção de mojibake: /${MOJIBAKE_RE}/`);
  console.log(apply ? 'MODO: --apply (vai gravar no banco)' : 'MODO: dry-run (só leitura, nada será gravado)');
  console.log(`Tamanho de lote (tabelas grandes): ${BATCH_SIZE}, pausa entre lotes: ${PAUSA_ENTRE_LOTES_MS}ms`);

  if (!soGrandes) {
    console.log('\n=== Tabelas de referência (pequenas) ===');
    for (const { table, columns } of TABELAS_PEQUENAS) {
      for (const column of columns) {
        await corrigirTabelaPequena(table, column, apply);
      }
    }
  }

  if (!soPequenas) {
    console.log('\n=== Tabelas grandes (em lotes) ===');
    for (const { table, columns } of TABELAS_GRANDES) {
      for (const column of columns) {
        await corrigirTabelaGrande(table, column, apply);
      }
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
