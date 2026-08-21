-- Índices necessários para o sistema de busca funcionar com performance
-- aceitável em tabelas de dezenas de milhões de linhas.
--
-- Rode isso UMA VEZ no servidor, dentro do psql:
--   psql -h localhost -U postgres -d cnpj -f indices.sql
--
-- Pode levar alguns minutos para completar (especialmente em
-- raw_estabelecimentos, que tem ~72 milhões de linhas). Isso é normal.

-- Chave de junção entre estabelecimentos, empresas e sócios
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_cnpj_basico ON raw_estabelecimentos (cnpj_basico);
CREATE INDEX IF NOT EXISTS idx_empresas_cnpj_basico ON raw_empresas (cnpj_basico);
CREATE INDEX IF NOT EXISTS idx_socios_cnpj_basico ON raw_socios (cnpj_basico);
CREATE INDEX IF NOT EXISTS idx_simples_cnpj_basico ON raw_simples (cnpj_basico);

-- Colunas mais usadas como filtro
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_uf ON raw_estabelecimentos (uf);
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_municipio ON raw_estabelecimentos (municipio);
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_situacao ON raw_estabelecimentos (situacao_cadastral);
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_cnae ON raw_estabelecimentos (cnae_fiscal_principal);
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_matriz ON raw_estabelecimentos (identificador_matriz_filial);

-- Filtro "tem telefone" / "tem email" (índice parcial, mais leve)
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_tem_telefone ON raw_estabelecimentos (cnpj_basico)
    WHERE ddd_1 IS NOT NULL AND ddd_1 != '' AND ddd_1 != '0';
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_tem_email ON raw_estabelecimentos (cnpj_basico)
    WHERE correio_eletronico IS NOT NULL AND correio_eletronico != '';

-- Busca por Razão Social / Nome Fantasia (ILIKE '%termo%') via trigram,
-- em vez de sequential scan nas tabelas de 72M/50M linhas.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_empresas_razao_social_trgm ON raw_empresas USING gin (razao_social gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_nome_fantasia_trgm ON raw_estabelecimentos USING gin (nome_fantasia gin_trgm_ops);

-- Atualiza estatísticas do planejador de consultas
ANALYZE raw_estabelecimentos;
ANALYZE raw_empresas;
ANALYZE raw_socios;
ANALYZE raw_simples;

-- =============================================================================
-- Chaves únicas + colunas tipadas (aplicado em 2026-08-18/19)
-- =============================================================================
-- Antes de aplicar, foi confirmado que raw_estabelecimentos não tem
-- duplicatas em (cnpj_basico, cnpj_ordem, cnpj_dv). raw_empresas tinha 1
-- linha "fantasma" (razao_social vazia, natureza_juridica='0000') duplicando
-- cnpj_basico='08314885' — foi removida antes da constraint.
--
-- Sem chave única, toda atualização semanal da RFB só pode ser feita via
-- TRUNCATE + reload completo. Com a chave, dá pra fazer UPSERT (INSERT ...
-- ON CONFLICT) processando só o delta.

ALTER TABLE raw_empresas
  ADD CONSTRAINT uq_empresa_cnpj_basico UNIQUE (cnpj_basico);

ALTER TABLE raw_estabelecimentos
  ADD CONSTRAINT uq_estabelecimento_cnpj UNIQUE (cnpj_basico, cnpj_ordem, cnpj_dv);

-- capital_social como TEXT ("9000,00", vírgula decimal) impedia ordenação e
-- filtro numérico corretos. Coluna gerada evita retrabalho no pipeline de
-- importação da RFB, que continua trazendo tudo cru como está.
ALTER TABLE raw_empresas
  ADD COLUMN capital_social_num NUMERIC
  GENERATED ALWAYS AS (NULLIF(REPLACE(capital_social, ',', '.'), '')::NUMERIC) STORED;

CREATE INDEX IF NOT EXISTS idx_empresas_capital_social_num ON raw_empresas (capital_social_num);

-- Datas em raw_estabelecimentos vêm como TEXT "YYYYMMDD" (data_situacao_cadastral
-- tem 116.057 linhas com o valor sentinela "0" em vez de data válida — vira
-- NULL). to_date()/to_char() não são IMMUTABLE, não podem ser usados direto
-- numa GENERATED column — daí esta função auxiliar com make_date() +
-- tratamento de exceção para datas de calendário inválidas.
--
-- ATENÇÃO: ADD COLUMN ... GENERATED ... STORED reescreve a tabela inteira.
-- Em raw_estabelecimentos (72M linhas, 23GB) isso trava a tabela (e portanto
-- a busca do site) por 40-90+ minutos. Rodar fora de horário de pico, e
-- NUNCA em paralelo com outro CREATE INDEX/ALTER TABLE pesado na mesma
-- tabela — isso já causou uma queda de site de várias horas por saturação de
-- IOPS do disco (2026-08-19). Confirmar espaço em disco livre >= tamanho da
-- tabela antes de rodar.
CREATE OR REPLACE FUNCTION parse_yyyymmdd(txt text) RETURNS date AS $$
BEGIN
  IF txt IS NULL OR txt !~ '^[0-9]{8}$' THEN
    RETURN NULL;
  END IF;
  RETURN make_date(
    substring(txt from 1 for 4)::int,
    substring(txt from 5 for 2)::int,
    substring(txt from 7 for 2)::int
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- PENDENTE (não aplicado ainda — tentativa de 2026-08-19 foi abortada por
-- degradação severa de I/O do disco, ver incidente acima):
-- ALTER TABLE raw_estabelecimentos
--   ADD COLUMN data_inicio_atividade_date DATE GENERATED ALWAYS AS (parse_yyyymmdd(data_inicio_atividade)) STORED,
--   ADD COLUMN data_situacao_cadastral_date DATE GENERATED ALWAYS AS (parse_yyyymmdd(data_situacao_cadastral)) STORED;
-- CREATE INDEX CONCURRENTLY idx_estabelecimentos_data_inicio ON raw_estabelecimentos (data_inicio_atividade_date);
-- CREATE INDEX CONCURRENTLY idx_estabelecimentos_data_situacao ON raw_estabelecimentos (data_situacao_cadastral_date);
