// Cria manualmente uma account + usuário de login (V1 é 1 usuário por
// account). Se o e-mail já existir, ATUALIZA a senha (e plano/export_max_rows
// se informados) da account existente em vez de falhar — mesmo comando serve
// pra criar e pra trocar senha depois. Uso:
//   node scripts/seed-account.js "<nome_empresa>" <email> <senha> [plano] [export_max_rows]
//
// plano: 'trial' (padrão) ou 'paid'.
// export_max_rows: padrão vem de DEFAULT_ACCOUNT_EXPORT_MAX_ROWS no .env.
//
// Não imprime a senha em nenhum momento — só o e-mail e o id da account
// criada/atualizada, pra você conferir.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
  const [, , nomeEmpresa, emailArg, senha, planoArg, exportMaxRowsArg] = process.argv;

  if (!nomeEmpresa || !emailArg || !senha) {
    console.error('Uso: node scripts/seed-account.js "<nome_empresa>" <email> <senha> [plano] [export_max_rows]');
    process.exit(1);
  }

  const plano = planoArg || 'trial';
  if (!['trial', 'paid'].includes(plano)) {
    console.error(`Plano inválido: "${plano}". Use "trial" ou "paid".`);
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const exportMaxRows = parseInt(
    exportMaxRowsArg || process.env.DEFAULT_ACCOUNT_EXPORT_MAX_ROWS || '100000',
    10
  );

  const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'cnpj',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
  });

  const senhaHash = await bcrypt.hash(senha, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT account_id FROM account_users WHERE email = $1`,
      [email]
    );

    let accountId;
    let acao;
    if (existing.rows[0]) {
      // Já existe: atualiza senha (e plano/export_max_rows, se passados
      // explicitamente na linha de comando) da account existente — não cria
      // duplicata.
      accountId = existing.rows[0].account_id;
      await client.query(
        `UPDATE account_users SET senha_hash = $1 WHERE account_id = $2`,
        [senhaHash, accountId]
      );
      if (planoArg || exportMaxRowsArg) {
        await client.query(
          `UPDATE accounts SET plano = $1, export_max_rows = $2 WHERE id = $3`,
          [plano, exportMaxRows, accountId]
        );
      }
      acao = 'atualizada (senha trocada)';
    } else {
      const accountResult = await client.query(
        `INSERT INTO accounts (nome_empresa, email_principal, plano, export_max_rows)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [nomeEmpresa, email, plano, exportMaxRows]
      );
      accountId = accountResult.rows[0].id;
      await client.query(
        `INSERT INTO account_users (account_id, email, senha_hash) VALUES ($1, $2, $3)`,
        [accountId, email, senhaHash]
      );
      acao = 'criada';
    }

    await client.query('COMMIT');

    console.log(`Account ${acao} com sucesso.`);
    console.log(`  account_id: ${accountId}`);
    console.log(`  nome_empresa: ${nomeEmpresa}`);
    console.log(`  plano: ${plano}`);
    console.log(`  export_max_rows: ${exportMaxRows}`);
    console.log(`  usuário (login): ${email}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
