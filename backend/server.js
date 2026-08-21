require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'cnpj',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: 10,
  // Termos de busca por nome muito genéricos (ex: sobrenomes comuns) podem
  // casar milhões de linhas e travar a query por minutos mesmo com índice.
  // Cortamos a query em vez de deixá-la (e o pool de conexões) travados.
  statement_timeout: 15000,
});

const QUERY_TIMEOUT_CODE = '57014'; // query_canceled (statement_timeout)

const SITUACOES = [
  { codigo: '01', descricao: 'Nula' },
  { codigo: '02', descricao: 'Ativa' },
  { codigo: '03', descricao: 'Suspensa' },
  { codigo: '04', descricao: 'Inapta' },
  { codigo: '08', descricao: 'Baixada' },
];

// Lista fixa em vez de consultar a base (72M linhas): o conjunto de UFs é
// estável (27 estados/DF + "EX" para estabelecimentos no exterior) e um
// SELECT DISTINCT nessa coluna baixa selectividade força um Seq Scan na
// tabela inteira toda vez que a tela carrega.
const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'EX', 'GO',
  'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ',
  'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];

// ---------------------------------------------------------------------------
// Monta a cláusula WHERE + parâmetros a partir dos filtros recebidos.
// Reutilizada tanto pela busca paginada quanto pela exportação.
// ---------------------------------------------------------------------------
function buildFilters(query) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (query.uf) {
    conditions.push(`e.uf = $${idx++}`);
    params.push(query.uf);
  }
  if (query.municipioCodigo) {
    conditions.push(`e.municipio = $${idx++}`);
    params.push(query.municipioCodigo);
  }
  if (query.cnaeCodigo) {
    conditions.push(`e.cnae_fiscal_principal = $${idx++}`);
    params.push(query.cnaeCodigo);
  }
  if (query.situacao) {
    const lista = Array.isArray(query.situacao) ? query.situacao : [query.situacao];
    conditions.push(`e.situacao_cadastral = ANY($${idx++})`);
    params.push(lista);
  }
  if (query.somenteMatriz === 'true') {
    conditions.push(`e.identificador_matriz_filial = '1'`);
  }
  if (query.temTelefone === 'true') {
    conditions.push(`e.ddd_1 IS NOT NULL AND e.ddd_1 != '' AND e.ddd_1 != '0'`);
  }
  if (query.temEmail === 'true') {
    conditions.push(`e.correio_eletronico IS NOT NULL AND e.correio_eletronico != ''`);
  }
  if (query.razaoSocial) {
    // Subquery por tabela em vez de OR pós-join: assim cada lado usa seu
    // próprio índice trigram (idx_empresas_razao_social_trgm /
    // idx_estabelecimentos_nome_fantasia_trgm) em vez de forçar um hash
    // join completo entre as duas tabelas de dezenas de milhões de linhas.
    conditions.push(`e.cnpj_basico IN (
      SELECT cnpj_basico FROM raw_empresas WHERE razao_social ILIKE $${idx}
      UNION
      SELECT cnpj_basico FROM raw_estabelecimentos WHERE nome_fantasia ILIKE $${idx}
    )`);
    params.push(`%${query.razaoSocial}%`);
    idx++;
  }

  // Filtros contra a tabela de enriquecimento (Sprint 3) — só entram no
  // JOIN da contagem quando realmente usados, pra não pesar buscas comuns.
  let needsEnrichmentJoin = false;
  if (query.apenasEmailValido === 'true') {
    conditions.push(`ec.email_dominio_mx_valido = true`);
    needsEnrichmentJoin = true;
  }
  if (query.apenasTelefoneValido === 'true') {
    conditions.push(`ec.telefone_formato_valido = true`);
    needsEnrichmentJoin = true;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIdx: idx, needsEnrichmentJoin };
}

const ENRICHMENT_JOIN = `LEFT JOIN enrichment_contato ec
    ON ec.cnpj_basico = e.cnpj_basico AND ec.cnpj_ordem = e.cnpj_ordem AND ec.cnpj_dv = e.cnpj_dv`;

const BASE_SELECT = `
  SELECT
    e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv AS cnpj,
    emp.razao_social,
    e.nome_fantasia,
    e.situacao_cadastral,
    e.cnae_fiscal_principal,
    cn.descricao AS cnae_descricao,
    e.logradouro, e.numero, e.bairro, e.cep,
    e.uf, mu.descricao AS municipio_nome,
    e.ddd_1, e.telefone_1, e.ddd_2, e.telefone_2,
    e.correio_eletronico,
    ec.score_contato, ec.email_dominio_mx_valido, ec.telefone_formato_valido
  FROM raw_estabelecimentos e
  LEFT JOIN raw_empresas emp ON emp.cnpj_basico = e.cnpj_basico
  LEFT JOIN raw_cnaes cn ON cn.codigo = e.cnae_fiscal_principal
  LEFT JOIN raw_municipios mu ON mu.codigo = e.municipio
  ${ENRICHMENT_JOIN}
`;

// ---------------------------------------------------------------------------
// Rotas de apoio para os dropdowns do frontend
// ---------------------------------------------------------------------------

app.get('/api/situacoes', (req, res) => {
  res.json(SITUACOES);
});

app.get('/api/ufs', (req, res) => {
  res.json(UFS);
});

app.get('/api/cnaes', async (req, res) => {
  const search = (req.query.search || '').trim();
  if (search.length < 2) return res.json([]);
  // codigo é salvo sem pontuação ("7312200"), mas o formato visual padrão da
  // CNAE é "7312-2/00" — aceita ambos buscando também só os dígitos digitados.
  const somenteDigitos = search.replace(/\D/g, '');
  try {
    const result = await pool.query(
      `SELECT codigo, descricao FROM raw_cnaes
       WHERE descricao ILIKE $1 OR codigo ILIKE $1 OR ($2 <> '' AND codigo ILIKE $2)
       ORDER BY descricao LIMIT 30`,
      [`%${search}%`, somenteDigitos ? `%${somenteDigitos}%` : '']
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar CNAEs' });
  }
});

app.get('/api/municipios', async (req, res) => {
  const search = (req.query.search || '').trim();
  if (search.length < 2) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT codigo, descricao FROM raw_municipios WHERE descricao ILIKE $1 ORDER BY descricao LIMIT 30`,
      [`%${search}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar municípios' });
  }
});

// ---------------------------------------------------------------------------
// Busca paginada (para exibir na tabela da tela)
// ---------------------------------------------------------------------------

// Acima desse número de linhas casando com o filtro, paramos de contar com
// exatidão (COUNT(*) exato em filtros amplos pode varrer dezenas de milhões
// de linhas). Mostramos "N+ resultados" nesse caso — a paginação de dados em
// si não é afetada, pois sempre usa LIMIT/OFFSET.
const COUNT_CAP = 50000;

app.get('/api/search', async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);
  const offset = (page - 1) * pageSize;

  const { where, params, nextIdx, needsEnrichmentJoin } = buildFilters(req.query);
  const countJoin = needsEnrichmentJoin ? ENRICHMENT_JOIN : '';
  const orderBy = req.query.ordenarPorScore === 'true'
    ? 'ec.score_contato DESC NULLS LAST, e.cnpj_basico'
    : 'e.cnpj_basico';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM (
         SELECT 1 FROM raw_estabelecimentos e
         ${countJoin}
         ${where}
         LIMIT ${COUNT_CAP + 1}
       ) t`,
      params
    );
    const rawCount = parseInt(countResult.rows[0].count, 10);
    const totalIsExact = rawCount <= COUNT_CAP;
    const total = totalIsExact ? rawCount : COUNT_CAP;

    const dataParams = [...params, pageSize, offset];
    const dataResult = await pool.query(
      `${BASE_SELECT} ${where} ORDER BY ${orderBy} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
      dataParams
    );

    res.json({
      total,
      totalIsExact,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      rows: dataResult.rows,
    });
  } catch (err) {
    if (err.code === QUERY_TIMEOUT_CODE) {
      return res.status(422).json({
        error: 'Busca muito ampla, o servidor levaria tempo demais para responder. Combine o nome com outro filtro (UF, CNAE, etc.) para refinar.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// ---------------------------------------------------------------------------
// Exportação em Excel (streaming, com limite de segurança de linhas)
// ---------------------------------------------------------------------------

const EXPORT_MAX_ROWS = 100000;

app.get('/api/export', async (req, res) => {
  const { where, params } = buildFilters(req.query);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="empresas.xlsx"');

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const sheet = workbook.addWorksheet('Empresas');

  sheet.columns = [
    { header: 'CNPJ', key: 'cnpj', width: 20 },
    { header: 'Razão Social', key: 'razao_social', width: 35 },
    { header: 'Nome Fantasia', key: 'nome_fantasia', width: 30 },
    { header: 'Situação', key: 'situacao_cadastral', width: 12 },
    { header: 'CNAE', key: 'cnae_fiscal_principal', width: 10 },
    { header: 'CNAE Descrição', key: 'cnae_descricao', width: 35 },
    { header: 'Logradouro', key: 'logradouro', width: 30 },
    { header: 'Número', key: 'numero', width: 10 },
    { header: 'Bairro', key: 'bairro', width: 20 },
    { header: 'CEP', key: 'cep', width: 12 },
    { header: 'UF', key: 'uf', width: 6 },
    { header: 'Município', key: 'municipio_nome', width: 25 },
    { header: 'DDD 1', key: 'ddd_1', width: 8 },
    { header: 'Telefone 1', key: 'telefone_1', width: 15 },
    { header: 'DDD 2', key: 'ddd_2', width: 8 },
    { header: 'Telefone 2', key: 'telefone_2', width: 15 },
    { header: 'E-mail', key: 'correio_eletronico', width: 30 },
  ];

  const client = await pool.connect();
  try {
    // Exportação legitimamente pode levar mais que os 10s do pool padrão
    // (até 100 mil linhas), então relaxamos o timeout só nesta conexão.
    await client.query(`SET statement_timeout = 30000`);
    const cursorQuery = `${BASE_SELECT} ${where} ORDER BY e.cnpj_basico LIMIT ${EXPORT_MAX_ROWS}`;
    const result = await client.query(cursorQuery, params);
    for (const row of result.rows) {
      sheet.addRow(row).commit();
    }
    sheet.commit();
    await workbook.commit();
  } catch (err) {
    if (!res.headersSent) {
      if (err.code === QUERY_TIMEOUT_CODE) {
        res.status(422).json({
          error: 'Busca muito ampla para exportar. Combine o nome com outro filtro (UF, CNAE, etc.) para refinar.',
        });
      } else {
        console.error(err);
        res.status(500).json({ error: 'Erro ao exportar dados' });
      }
    } else {
      res.end();
    }
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});
