-- Correção estrutural: site institucional é 1:1 com cnpj_basico (empresa),
-- não com cada estabelecimento (cnpj_basico+cnpj_ordem+cnpj_dv). A tabela
-- enrichment_digital do primeiro teste ficou obsoleta pra esse propósito —
-- só tem os 150 registros de teste (majoritariamente ruído, filiais do
-- Banco do Brasil com nome_fantasia = nome de cidade). Não foi apagada
-- automaticamente; se quiser limpar, TRUNCATE enrichment_digital ou DROP
-- TABLE depois de confirmar que nada mais depende dela.

CREATE TABLE IF NOT EXISTS enrichment_site (
  cnpj_basico TEXT PRIMARY KEY,
  site_url TEXT,
  site_status_http INTEGER,
  site_confirmado BOOLEAN DEFAULT false, -- true só após achar CNPJ/razão social no HTML
  site_ultima_verificacao TIMESTAMP,
  prioridade SMALLINT DEFAULT 5,
  processado BOOLEAN DEFAULT false,
  atualizado_em TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_site_fila
  ON enrichment_site (prioridade, processado)
  WHERE processado = false;

CREATE INDEX IF NOT EXISTS idx_enrichment_site_confirmado
  ON enrichment_site (site_confirmado)
  WHERE site_confirmado = true;
