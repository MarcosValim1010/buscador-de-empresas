-- Tabela de enriquecimento de contato (Sprint 3).
--
-- Só CREATE TABLE (metadado, instantâneo) — não toca nas tabelas de 72M
-- linhas com ALTER. É populada aos poucos pelo enrich-contato.js, que só faz
-- SELECT de leitura + INSERT/UPSERT nesta tabela nova, em lotes pequenos.

CREATE TABLE IF NOT EXISTS enrichment_contato (
  cnpj_basico TEXT NOT NULL,
  cnpj_ordem TEXT NOT NULL,
  cnpj_dv TEXT NOT NULL,
  email_original TEXT,
  email_sintaxe_valida BOOLEAN,
  email_dominio_mx_valido BOOLEAN,
  telefone_original TEXT,
  telefone_ddd_valido BOOLEAN,
  telefone_formato_valido BOOLEAN,
  telefone_tipo TEXT, -- 'movel' | 'fixo' | 'invalido'
  score_contato NUMERIC, -- 0 a 1
  atualizado_em TIMESTAMP DEFAULT now(),
  PRIMARY KEY (cnpj_basico, cnpj_ordem, cnpj_dv)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_score ON enrichment_contato (score_contato);
CREATE INDEX IF NOT EXISTS idx_enrichment_email_valido ON enrichment_contato (email_dominio_mx_valido);
CREATE INDEX IF NOT EXISTS idx_enrichment_telefone_valido ON enrichment_contato (telefone_formato_valido);

-- Cache de domínio: evita repetir a mesma consulta MX centenas de milhares
-- de vezes (gmail.com, hotmail.com, uol.com.br etc. cobrem a maioria).
CREATE TABLE IF NOT EXISTS dominio_mx_cache (
  dominio TEXT PRIMARY KEY,
  tem_mx BOOLEAN,
  verificado_em TIMESTAMP DEFAULT now()
);
