-- Rodar antes do discover-site.js, se ainda não existirem

CREATE TABLE IF NOT EXISTS enrichment_digital (
  cnpj_basico TEXT NOT NULL,
  cnpj_ordem TEXT NOT NULL,
  cnpj_dv TEXT NOT NULL,
  site_url TEXT,
  site_status_http INTEGER,
  site_ultima_verificacao TIMESTAMP,
  linkedin_url TEXT,
  linkedin_encontrado_em TIMESTAMP,
  prioridade SMALLINT DEFAULT 5,
  processado BOOLEAN DEFAULT false,
  atualizado_em TIMESTAMP DEFAULT now(),
  PRIMARY KEY (cnpj_basico, cnpj_ordem, cnpj_dv)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_digital_fila
  ON enrichment_digital (prioridade, processado)
  WHERE processado = false;

CREATE INDEX IF NOT EXISTS idx_enrichment_digital_site
  ON enrichment_digital (site_url)
  WHERE site_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS robots_cache (
  dominio TEXT PRIMARY KEY,
  permite_scraping BOOLEAN,
  verificado_em TIMESTAMP DEFAULT now()
);
