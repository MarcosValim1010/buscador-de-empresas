-- Base de autenticação e controle de acesso (V1).
--
-- Modelo: a unidade de cobrança é "account", não "user". account_users é
-- uma tabela separada mesmo sendo 1:1 hoje, exatamente pra não exigir
-- reescrita quando vier multi-usuário por account. CPF/billing ficam fora
-- de propósito — nenhuma tabela aqui prevê ou bloqueia isso.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_empresa TEXT NOT NULL,
  email_principal TEXT NOT NULL,
  plano TEXT NOT NULL DEFAULT 'trial',
  export_max_rows INTEGER NOT NULL DEFAULT 100000,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ativo BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT accounts_plano_check CHECK (plano IN ('trial', 'paid'))
);

CREATE TABLE IF NOT EXISTS account_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ativo BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_account_users_account_id ON account_users (account_id);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  ip TEXT,
  export_max_rows INTEGER NOT NULL DEFAULT 1000,
  exportacoes_realizadas INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_account_id UUID REFERENCES accounts(id)
);
-- Um lead por e-mail (case-insensitive) — repetir o mesmo e-mail deve achar
-- o registro existente, não duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_email_lower ON leads (lower(email));
