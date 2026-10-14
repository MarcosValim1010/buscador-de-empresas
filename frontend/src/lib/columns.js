const EMPTY = '—';

function fmtBool(v) {
  if (v === true) return 'Sim';
  if (v === false) return 'Não';
  return EMPTY;
}

function fmtScore(v) {
  if (v === null || v === undefined) return EMPTY;
  return Number(v).toFixed(2);
}

// Datas do layout da Receita Federal vêm como "YYYYMMDD" (ex: "20130521").
function fmtDataRFB(v) {
  if (!v) return EMPTY;
  const s = String(v);
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  }
  return s;
}

export const COLUMN_DEFS = [
  { key: 'cnpj', label: 'CNPJ', locked: true, mono: true, render: (r) => r.cnpj || EMPTY },
  { key: 'razao_social', label: 'Razão Social', locked: true, render: (r) => r.razao_social || EMPTY },
  { key: 'nome_fantasia', label: 'Nome Fantasia', locked: true, render: (r) => r.nome_fantasia || EMPTY },
  { key: 'uf', label: 'UF', locked: true, render: (r) => r.uf || EMPTY },
  { key: 'municipio_nome', label: 'Município', locked: true, render: (r) => r.municipio_nome || EMPTY },
  {
    key: 'telefone',
    label: 'Telefone',
    locked: true,
    mono: true,
    render: (r) => (r.ddd_1 && r.ddd_1 !== '0' ? `(${r.ddd_1}) ${r.telefone_1}` : EMPTY),
  },
  { key: 'correio_eletronico', label: 'E-mail', locked: true, render: (r) => r.correio_eletronico || EMPTY },

  // Sócios (backend, sprint atual): achatado, um sócio por linha — quando a
  // empresa tem mais de um, o backend já escolhe (prioriza
  // Administrador/Sócio-Administrador, depois entrada mais antiga). Vêm
  // visíveis por padrão (diferente dos campos de Enriquecimento abaixo),
  // mas continuam ocultáveis pelo seletor de Colunas.
  {
    key: 'nome_socio',
    label: 'Sócio',
    group: 'Sócios',
    defaultVisible: true,
    render: (r) => r.nome_socio || EMPTY,
  },
  {
    key: 'qualificacao_socio',
    label: 'Qualificação do sócio',
    group: 'Sócios',
    defaultVisible: true,
    render: (r) => r.qualificacao_socio || EMPTY,
  },
  {
    key: 'data_entrada_socio',
    label: 'Data de entrada',
    group: 'Sócios',
    defaultVisible: true,
    render: (r) => fmtDataRFB(r.data_entrada_socio),
  },
  {
    key: 'faixa_etaria_socio',
    label: 'Faixa etária do sócio',
    group: 'Sócios',
    defaultVisible: true,
    render: (r) => r.faixa_etaria_socio || EMPTY,
  },
  {
    key: 'cpf_cnpj_socio_mascarado',
    label: 'CPF/CNPJ do sócio',
    group: 'Sócios',
    defaultVisible: true,
    mono: true,
    render: (r) => r.cpf_cnpj_socio_mascarado || EMPTY,
  },

  { key: 'situacao_cadastral', label: 'Situação', group: 'Cadastro', render: (r) => r.situacao_cadastral || EMPTY },
  {
    key: 'cnae_descricao',
    label: 'CNAE',
    group: 'Cadastro',
    render: (r) => r.cnae_descricao || r.cnae_fiscal_principal || EMPTY,
  },
  { key: 'bairro', label: 'Bairro', group: 'Cadastro', render: (r) => r.bairro || EMPTY },
  { key: 'cep', label: 'CEP', group: 'Cadastro', mono: true, render: (r) => r.cep || EMPTY },

  {
    key: 'score_contato',
    label: 'Score contato',
    group: 'Enriquecimento',
    render: (r) => fmtScore(r.score_contato),
  },
  {
    key: 'email_dominio_mx_valido',
    label: 'E-mail válido (MX)',
    group: 'Enriquecimento',
    render: (r) => fmtBool(r.email_dominio_mx_valido),
  },
  {
    key: 'telefone_formato_valido',
    label: 'Telefone válido',
    group: 'Enriquecimento',
    render: (r) => fmtBool(r.telefone_formato_valido),
  },
  {
    key: 'site_url',
    label: 'Site',
    group: 'Enriquecimento',
    render: (r) => r.site_url || EMPTY,
  },
  {
    key: 'site_confirmado',
    label: 'Site confirmado',
    group: 'Enriquecimento',
    render: (r) => fmtBool(r.site_confirmado),
  },
  {
    key: 'score_empresa_viva',
    label: 'Score empresa viva',
    group: 'Enriquecimento',
    render: (r) => fmtScore(r.score_empresa_viva),
  },
];

export const DEFAULT_VISIBLE_COLUMNS = COLUMN_DEFS.filter((c) => c.locked || c.defaultVisible).map(
  (c) => c.key
);
