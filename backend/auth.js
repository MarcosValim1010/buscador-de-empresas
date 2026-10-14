const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

// Assina o JWT com os dados de plano/limite já embutidos, pra não precisar
// consultar o banco a cada request autenticada. Trade-off aceito pra V1:
// se o export_max_rows de uma account mudar, quem já tem token só vê o
// valor novo depois de logar de novo (até 7 dias de defasagem).
function signToken(account) {
  return jwt.sign(
    {
      accountId: account.id,
      plano: account.plano,
      exportMaxRows: account.export_max_rows,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Decodifica a sessão, quando presente. O token só é aceito pelo header
// Authorization: Bearer para não vazar credenciais em URL, histórico ou logs.
function requireAuth(req, res, next) {
  req.account = null;

  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token = headerToken || null;

  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.account = {
        id: payload.accountId,
        plano: payload.plano,
        export_max_rows: payload.exportMaxRows,
      };
    } catch (err) {
      // Token ausente/inválido/expirado -> segue como acesso anônimo.
    }
  }

  next();
}

function requireAuthenticated(req, res, next) {
  if (!req.account) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAuthenticated };
