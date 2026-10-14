-- Fase 8-10 (Website Enrichment Worker): extrai telefone/whatsapp/email/redes
-- sociais dos sites já confirmados pelo Sprint 4 (enrichment_site.site_confirmado).
-- Só CREATE TABLE/ADD COLUMN (metadado, instantâneo) — sem tocar nas tabelas
-- grandes (raw_*), sem reescrita de tabela existente.

CREATE TABLE IF NOT EXISTS company_contact (
  id SERIAL PRIMARY KEY,
  cnpj_basico TEXT NOT NULL,
  type TEXT NOT NULL,               -- 'telefone' | 'whatsapp' | 'email' | 'instagram' | 'facebook' | 'linkedin' | 'tiktok' | 'youtube' | 'twitter'
  normalized_value TEXT NOT NULL,
  raw_value TEXT,                   -- valor original como encontrado, antes de normalizar (auditoria)
  source TEXT NOT NULL,             -- 'WEBSITE'
  source_url TEXT,                  -- página específica onde foi encontrado
  confidence INTEGER NOT NULL DEFAULT 100,
  first_seen_at TIMESTAMP DEFAULT now(),
  last_seen_at TIMESTAMP DEFAULT now(),
  active BOOLEAN DEFAULT true,
  UNIQUE (cnpj_basico, type, normalized_value, source)
);

CREATE INDEX IF NOT EXISTS idx_company_contact_cnpj ON company_contact (cnpj_basico);
CREATE INDEX IF NOT EXISTS idx_company_contact_type ON company_contact (type);

-- Colunas de controle em enrichment_site (mesmo padrão de `processado` já
-- usado pelo Sprint 4 — nome diferente pra não colidir com o controle do
-- discover-site.js, que é uma etapa anterior e independente).
ALTER TABLE enrichment_site
  ADD COLUMN IF NOT EXISTS contato_processado BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS contato_processado_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS contato_ultimo_erro TEXT;

-- Fila do worker: só sites confirmados, ainda não processados pra contato.
CREATE INDEX IF NOT EXISTS idx_enrichment_site_fila_contato
  ON enrichment_site (contato_processado)
  WHERE site_confirmado = true AND contato_processado = false;
