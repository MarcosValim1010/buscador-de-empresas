require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signToken, requireAuth, requireAuthenticated } = require('./auth');

// A porta 3001 fica exposta publicamente por ora (o build atual do frontend
// chama a API direto pelo IP público — fechar exigiria nginx como proxy
// reverso na frente, fora do escopo de hoje). Esses limites são a mitigação
// imediata contra brute-force de login e abuso do fluxo de export anônimo
// vindos da internet aberta, não um substituto pra isso.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
});
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas exportações a partir deste IP na última hora. Tente novamente mais tarde.' },
});

const app = express();
// A API recebe tráfego do Caddy pela rede privada. Confiamos apenas em
// proxies locais/privados para que rate limits usem o IP real sem permitir
// que acessos diretos falsifiquem X-Forwarded-For.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(cors());
app.use(express.json());
// Identifica a sessão quando há JWT válido. As rotas que acessam dados
// empresariais aplicam requireAuthenticated explicitamente.
app.use(requireAuth);

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
  // O container do Postgres tem --shm-size de só 64MB (padrão Docker); um
  // plano paralelo em queries com mais JOINs (ex: score_empresa_viva do
  // Sprint 5) estoura esse limite de memória compartilhada. Mesma correção
  // já aplicada em discover-site.js/seed-enrichment.js.
  options: '-c max_parallel_workers_per_gather=0',
});

const QUERY_TIMEOUT_CODE = '57014'; // query_canceled (statement_timeout)

// Revalida a conta no banco em cada operação protegida. Além de bloquear
// imediatamente contas desativadas, faz mudanças de plano/limite valerem
// para sessões já abertas — necessário para upgrades pagos futuros.
async function requireActiveAccount(req, res, next) {
  if (!req.account) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }
  try {
    const result = await pool.query(
      `SELECT plano, export_max_rows FROM accounts WHERE id = $1 AND ativo = true`,
      [req.account.id]
    );
    const account = result.rows[0];
    if (!account) {
      return res.status(401).json({ error: 'Sua conta não está ativa.' });
    }
    req.account = {
      id: req.account.id,
      plano: account.plano,
      export_max_rows: account.export_max_rows,
    };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao validar a conta.' });
  }
}

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
    // Aceita valor único ou array (multi-seleção) — Express já entrega array
    // quando a mesma chave repete na query string (?municipioCodigo=A&municipioCodigo=B).
    const lista = Array.isArray(query.municipioCodigo) ? query.municipioCodigo : [query.municipioCodigo];
    conditions.push(`e.municipio = ANY($${idx++})`);
    params.push(lista);
  }
  if (query.cnaeCodigo) {
    const lista = Array.isArray(query.cnaeCodigo) ? query.cnaeCodigo : [query.cnaeCodigo];
    conditions.push(`e.cnae_fiscal_principal = ANY($${idx++})`);
    params.push(lista);
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

  // Score composto "empresa viva" (Sprint 5) — combina Sprint 3 (contato) e
  // Sprint 4 (site). Precisa dos dois JOINs quando usado como filtro.
  let needsSiteJoin = false;
  if (query.scoreMinimo) {
    const minimo = parseFloat(query.scoreMinimo);
    if (!Number.isNaN(minimo)) {
      conditions.push(`${SCORE_EMPRESA_VIVA_EXPR} >= $${idx++}`);
      params.push(minimo);
      needsEnrichmentJoin = true;
      needsSiteJoin = true;
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIdx: idx, needsEnrichmentJoin, needsSiteJoin };
}

const ENRICHMENT_JOIN = `LEFT JOIN enrichment_contato ec
    ON ec.cnpj_basico = e.cnpj_basico AND ec.cnpj_ordem = e.cnpj_ordem AND ec.cnpj_dv = e.cnpj_dv`;

const SITE_JOIN = `LEFT JOIN enrichment_site es ON es.cnpj_basico = e.cnpj_basico`;

// Sócio "principal" da empresa (raw_socios é 1:N por cnpj_basico — uma
// empresa pode ter vários sócios). Critério escolhido: Administrador ou
// Sócio-Administrador (códigos 05/49 em raw_qualificacoes) tem prioridade
// sobre qualquer outra qualificação; entre sócios empatados nesse critério
// (ou quando não há administrador), desempata pelo mais antigo por data de
// entrada (data_entrada_sociedade é texto AAAAMMDD, ordena cronologicamente
// como string). cpf_cnpj_socio já vem mascarado da própria Receita Federal
// pra pessoa física (formato "***123456**", confirmado em amostra real) —
// não precisou de mascaramento adicional. Pessoa jurídica (identificador_socio
// = '1') vem com CNPJ completo, o que é correto (não é dado pessoal).
const SOCIO_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      s.identificador_socio,
      s.nome_socio_razao_social AS nome_socio,
      s.faixa_etaria AS faixa_etaria_socio,
      s.cpf_cnpj_socio AS cpf_cnpj_socio_mascarado,
      s.qualificacao_socio,
      s.data_entrada_sociedade AS data_entrada_socio
    FROM raw_socios s
    WHERE s.cnpj_basico = e.cnpj_basico
    ORDER BY
      CASE WHEN s.qualificacao_socio IN ('05', '49') THEN 0 ELSE 1 END,
      s.data_entrada_sociedade ASC
    LIMIT 1
  ) soc ON true
`;

// Score composto "empresa viva" (0 a 1): média ponderada entre o score de
// contato (Sprint 3) e um sinal de site institucional (Sprint 4).
// Ausência de dado (pipeline ainda não chegou nessa empresa) vira neutro
// (0.5), não zero — não queremos penalizar quem só ainda não foi processado.
// Dentro do componente de site: confirmado por conteúdo pesa mais que
// "achou um candidato mas não confirmou", que por sua vez pesa mais que
// "processado e não achou nada" (sinal negativo real, não ausência de dado).
const SCORE_EMPRESA_VIVA_EXPR = `(
  COALESCE(ec.score_contato, 0.5) * 0.5
  + COALESCE(
      CASE
        WHEN es.cnpj_basico IS NULL THEN 0.5
        WHEN es.site_confirmado THEN 1.0
        WHEN es.site_url IS NOT NULL THEN 0.6
        ELSE 0.0
      END, 0.5
    ) * 0.5
)`;

// Parametrizada pela cláusula FROM: a busca paginada lê direto de
// raw_estabelecimentos (OFFSET pequeno, ok fazer o JOIN antes do filtro);
// a exportação usa uma variante que junta os enriquecimentos só DEPOIS de
// já ter resolvido o LIMIT (ver EXPORT_FROM_KEYS) — ver comentário lá.
function buildDataQuery(fromClause) {
  return `
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
      ec.score_contato, ec.email_dominio_mx_valido, ec.telefone_formato_valido,
      es.site_url, es.site_confirmado,
      ${SCORE_EMPRESA_VIVA_EXPR} AS score_empresa_viva,
      soc.identificador_socio, soc.nome_socio, soc.faixa_etaria_socio,
      soc.cpf_cnpj_socio_mascarado, soc.qualificacao_socio, soc.data_entrada_socio
    ${fromClause}
    LEFT JOIN raw_empresas emp ON emp.cnpj_basico = e.cnpj_basico
    LEFT JOIN raw_cnaes cn ON cn.codigo = e.cnae_fiscal_principal
    LEFT JOIN raw_municipios mu ON mu.codigo = e.municipio
    ${ENRICHMENT_JOIN}
    ${SITE_JOIN}
    ${SOCIO_JOIN}
  `;
}

const BASE_SELECT = buildDataQuery('FROM raw_estabelecimentos e');

// ---------------------------------------------------------------------------
// Autenticação de account (V1: 1 usuário por account, sem recuperação de
// senha / verificação de e-mail — fora de escopo por ora).
// ---------------------------------------------------------------------------

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ error: 'Informe email e senha.' });
  }

  try {
    const result = await pool.query(
      `SELECT au.senha_hash, au.ativo AS usuario_ativo,
              a.id AS account_id, a.plano, a.export_max_rows, a.ativo AS account_ativo
       FROM account_users au
       JOIN accounts a ON a.id = au.account_id
       WHERE au.email = $1`,
      [String(email).trim().toLowerCase()]
    );
    const row = result.rows[0];

    // Mesma mensagem de erro pra usuário inexistente e senha errada —
    // não vazar qual das duas coisas falhou.
    if (!row || !row.usuario_ativo || !row.account_ativo) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    const senhaOk = await bcrypt.compare(senha, row.senha_hash);
    if (!senhaOk) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = signToken({
      id: row.account_id,
      plano: row.plano,
      export_max_rows: row.export_max_rows,
    });
    res.json({
      token,
      account: {
        accountId: row.account_id,
        plano: row.plano,
        exportMaxRows: row.export_max_rows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao autenticar.' });
  }
});

app.get('/api/auth/me', requireAuthenticated, requireActiveAccount, (req, res) => {
  res.json({
    account: {
      accountId: req.account.id,
      plano: req.account.plano,
      exportMaxRows: req.account.export_max_rows,
    },
  });
});

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
  // Aceita "busca" (nome atual pedido) e "search" (nome já em uso pelo
  // Typeahead existente) como aliases do mesmo parâmetro — mantém os dois
  // funcionando ao mesmo tempo, sem quebrar quem já chama com "search".
  const search = String(req.query.busca || req.query.search || '').trim();
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

// O filtro visível no CRM usa linguagem comercial ("restaurante", "loja
// de informática", "pizzaria"), não a nomenclatura fiscal. O CNAE continua
// sendo usado somente como chave interna porque é assim que a Receita
// classifica os estabelecimentos.
const BUSINESS_TYPE_ALIASES = [
  { matches: ['pizzaria', 'hamburgueria'], searches: ['restaurante', 'lanchonete'] },
  { matches: ['padaria'], searches: ['padaria', 'confeitaria'] },
  { matches: ['mercado', 'supermercado'], searches: ['supermercado', 'minimercado', 'mercearia'] },
  { matches: ['farmacia', 'drogaria'], searches: ['comercio varejista de produtos farmaceuticos'] },
  { matches: ['academia'], searches: ['condicionamento fisico'] },
  { matches: ['salao de beleza', 'cabeleireiro'], searches: ['cabeleireiros', 'manicure', 'pedicure'] },
  { matches: ['dentista', 'clinica odontologica'], searches: ['odontologica'] },
  { matches: ['clinica medica'], searches: ['medica ambulatorial'] },
  {
    matches: ['pet shop', 'petshop'],
    searches: ['comercio varejista de animais vivos e de artigos e alimentos para animais de estimacao'],
  },
  { matches: ['oficina mecanica'], searches: ['reparacao mecanica de veiculos'] },
  { matches: ['advogado', 'advocacia'], searches: ['advocaticios'] },
  {
    matches: ['loja de informatica', 'lojas de informatica'],
    searches: ['comercio varejista especializado de equipamentos e suprimentos de informatica'],
  },
  {
    matches: ['loja de roupa', 'loja de roupas', 'lojas de roupa', 'lojas de roupas'],
    searches: ['comercio varejista de artigos do vestuario'],
  },
];

const BUSINESS_TYPE_STOP_WORDS = new Set([
  'a', 'as', 'de', 'do', 'da', 'dos', 'das', 'e', 'empresa', 'empresas',
  'loja', 'lojas', 'negocio', 'negocios', 'servico', 'servicos',
]);

function normalizeBusinessType(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getBusinessTypeSearches(value) {
  const normalized = normalizeBusinessType(value);
  const aliasSearches = BUSINESS_TYPE_ALIASES
    .filter((alias) => alias.matches.some((match) => normalized.includes(match)))
    .flatMap((alias) => alias.searches);

  // Quando reconhecemos um termo comercial, usamos a tradução curada em
  // vez da palavra solta. Isso evita, por exemplo, que "loja de informática"
  // sugira atacadistas ou atividades cuja descrição diz "exceto informática".
  if (aliasSearches.length) return [...new Set(aliasSearches)];

  const searches = new Set([normalized]);
  const meaningfulWords = normalized
    .split(' ')
    .filter((word) => word.length >= 3 && !BUSINESS_TYPE_STOP_WORDS.has(word));

  if (meaningfulWords.length) searches.add(meaningfulWords.join(' '));

  return [...searches].filter((search) => search.length >= 2);
}

app.get('/api/tipos-empresa', async (req, res) => {
  const search = String(req.query.busca || req.query.search || '').trim();
  if (normalizeBusinessType(search).length < 2) return res.json([]);

  const searches = getBusinessTypeSearches(search);
  const patterns = searches.map((item) => `%${item}%`);
  const normalizedDescription = `translate(
    lower(descricao),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc'
  )`;

  try {
    const result = await pool.query(
      `SELECT MIN(codigo) AS codigo,
              ARRAY_AGG(codigo ORDER BY codigo) AS codigos,
              descricao
       FROM raw_cnaes
       WHERE ${normalizedDescription} LIKE ANY($1::text[])
       GROUP BY descricao
       ORDER BY
         CASE WHEN ${normalizedDescription} LIKE $2 THEN 0 ELSE 1 END,
         descricao
       LIMIT 30`,
      [patterns, `%${normalizeBusinessType(search)}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar tipos de empresa' });
  }
});

app.get('/api/municipios', async (req, res) => {
  const search = String(req.query.busca || req.query.search || '').trim();
  try {
    // Sem termo de busca: devolve a lista completa (só ~5.570 municípios,
    // leve o bastante pra carregar de uma vez e o frontend filtrar
    // internamente num dropdown de multi-seleção). Com termo: mantém o
    // comportamento de typeahead já existente (filtrado + limitado).
    const result = search.length >= 2
      ? await pool.query(
          `SELECT codigo, descricao FROM raw_municipios WHERE descricao ILIKE $1 ORDER BY descricao LIMIT 30`,
          [`%${search}%`]
        )
      : await pool.query(`SELECT codigo, descricao FROM raw_municipios ORDER BY descricao`);
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

app.get('/api/search', requireAuthenticated, requireActiveAccount, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);
  const offset = (page - 1) * pageSize;

  const { where, params, nextIdx, needsEnrichmentJoin, needsSiteJoin } = buildFilters(req.query);
  const countJoin = [
    needsEnrichmentJoin ? ENRICHMENT_JOIN : '',
    needsSiteJoin ? SITE_JOIN : '',
  ].filter(Boolean).join('\n');
  const orderBy = req.query.ordenarPorScoreEmpresaViva === 'true'
    ? `${SCORE_EMPRESA_VIVA_EXPR} DESC NULLS LAST, e.cnpj_basico`
    : req.query.ordenarPorScore === 'true'
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
        error: 'Busca muito ampla, o servidor levaria tempo demais para responder. Combine o nome com outro filtro (UF, tipo de empresa, etc.) para refinar.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// ---------------------------------------------------------------------------
// Exportação em Excel (streaming, com limite de segurança de linhas)
// ---------------------------------------------------------------------------

// Teto absoluto de segurança — nenhuma account, por maior que seja seu
// export_max_rows configurado, exporta mais que isso numa chamada só.
// Valor medido nesta sprint: com os 5 JOINs de enriquecimento, cada 1000
// linhas custa ~500ms (são até 4 buscas pontuais por linha em tabelas de
// dezenas de milhões de registros — I/O aleatório, não sequencial). 50.000
// linhas já levou ~25s, perto demais do limite de conexão. 60.000 fica com
// margem segura dentro do EXPORT_STATEMENT_TIMEOUT_MS abaixo.
const EXPORT_MAX_ROWS_HARD_CAP = 60000;
const EXPORT_STATEMENT_TIMEOUT_MS = 45000;

// A exportação junta 5 tabelas (raw_empresas, raw_cnaes, raw_municipios,
// enrichment_contato, enrichment_site) pra cada linha. Descoberto ao testar
// esta sprint: fazer esse JOIN completo ANTES do ORDER BY + LIMIT faz o
// planner abandonar o index scan ordenado que existe pra filtros simples
// (comprovado em 588ms via EXPLAIN pra uf=SP+LIMIT 100000 sem os JOINs) e
// estourar os 30s de timeout em filtros amplos — resultado: um .xlsx
// truncado/quase vazio entregue como se fosse sucesso (headers já tinham
// sido enviados). Por isso, o export busca as chaves (rápido, já ORDER BY +
// LIMIT resolvido) primeiro, e só faz o JOIN de enriquecimento DEPOIS, já
// em cima do conjunto pequeno e fixo de linhas que vai pro arquivo.
const EXPORT_FROM_KEYS = `
  FROM unnest($1::text[], $2::text[], $3::text[]) AS chave(cnpj_basico, cnpj_ordem, cnpj_dv)
  JOIN raw_estabelecimentos e
    ON e.cnpj_basico = chave.cnpj_basico
   AND e.cnpj_ordem = chave.cnpj_ordem
   AND e.cnpj_dv = chave.cnpj_dv
`;

app.get('/api/export', requireAuthenticated, requireActiveAccount, exportLimiter, async (req, res) => {
  const maxRows = Math.min(req.account.export_max_rows, EXPORT_MAX_ROWS_HARD_CAP);

  const { where, params, nextIdx, needsEnrichmentJoin, needsSiteJoin } = buildFilters(req.query);
  const whereJoin = [
    needsEnrichmentJoin ? ENRICHMENT_JOIN : '',
    needsSiteJoin ? SITE_JOIN : '',
  ].filter(Boolean).join('\n');

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
    { header: 'Sócio (nome)', key: 'nome_socio', width: 35 },
    { header: 'Sócio (qualificação)', key: 'qualificacao_socio', width: 12 },
    { header: 'Sócio (CPF/CNPJ mascarado)', key: 'cpf_cnpj_socio_mascarado', width: 20 },
    { header: 'Sócio (faixa etária)', key: 'faixa_etaria_socio', width: 12 },
    { header: 'Sócio (data de entrada)', key: 'data_entrada_socio', width: 16 },
  ];

  const client = await pool.connect();
  try {
    // Exportação legitimamente pode levar mais que os 10s do pool padrão
    // (até 100 mil linhas), então relaxamos o timeout só nesta conexão.
    await client.query(`SET statement_timeout = ${EXPORT_STATEMENT_TIMEOUT_MS}`);

    // Fase 1: só as chaves, ordenadas e já limitadas — rápido, usa o índice
    // de raw_estabelecimentos direto (sem os JOINs de enriquecimento no
    // meio pra atrapalhar o planner). Corta silenciosamente em maxRows via
    // LIMIT em vez de checar a contagem antes e abortar — um COUNT(*) prévio
    // sobre filtros amplos é caro (por isso /api/search usa COUNT_CAP) e o
    // requisito é "exportar as primeiras N", não "recusar se passar de N".
    const keysQuery = `
      SELECT e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv
      FROM raw_estabelecimentos e
      ${whereJoin}
      ${where}
      ORDER BY e.cnpj_basico
      LIMIT $${nextIdx}
    `;
    const keysResult = await client.query(keysQuery, [...params, maxRows]);
    const cnpjBasicos = keysResult.rows.map((r) => r.cnpj_basico);
    const cnpjOrdens = keysResult.rows.map((r) => r.cnpj_ordem);
    const cnpjDvs = keysResult.rows.map((r) => r.cnpj_dv);

    // Fase 2: junta os enriquecimentos só nesse conjunto já resolvido de
    // linhas (no máximo maxRows) — o JOIN aqui é barato, ponto-a-ponto pelo
    // índice único, não um full scan+sort de milhões de linhas.
    let result = { rows: [] };
    if (cnpjBasicos.length > 0) {
      const exportQuery = `${buildDataQuery(EXPORT_FROM_KEYS)} ORDER BY e.cnpj_basico`;
      result = await client.query(exportQuery, [cnpjBasicos, cnpjOrdens, cnpjDvs]);
    }
    for (const row of result.rows) {
      sheet.addRow(row).commit();
    }
    sheet.commit();
    await workbook.commit();

  } catch (err) {
    if (!res.headersSent) {
      if (err.code === QUERY_TIMEOUT_CODE) {
        res.status(422).json({
          error: 'Busca muito ampla para exportar. Combine o nome com outro filtro (UF, tipo de empresa, etc.) para refinar.',
        });
      } else {
        console.error(err);
        res.status(500).json({ error: 'Erro ao exportar dados' });
      }
    } else {
      // Headers (e algum dado) já foram pro cliente — não dá mais pra
      // trocar o status HTTP. Registra de qualquer forma: antes essa
      // falha ficava completamente muda no log, indistinguível de sucesso.
      console.error('Export interrompido após envio dos headers:', err);
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
