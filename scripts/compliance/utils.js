// utils.js — sanitização de CPF e normalização de CNPJ, compartilhadas entre
// exploração e ingestão das fontes de compliance (Sprint C1/C2).
//
// Princípio de minimização (decisão do usuário, 2026-08-24): nossa base
// (raw_socios) só guarda CPF mascarado, então CPF completo não aumenta a
// precisão do matching — só retém dado sensível sem necessidade. Por isso,
// TODO payload é sanitizado antes de qualquer gravação, inclusive dentro do
// JSON bruto (detalhe_original).

// Máscara no mesmo padrão da nossa base: ***XXXXXX** (3 mascarados, 6
// visíveis do meio, 2 mascarados) — ex.: "542.420.376-00" -> "***.420.376-**"
function mascararCpf11Digitos(digitos) {
  const meio = digitos.slice(3, 9); // 6 dígitos do meio
  return `***.${meio.slice(0, 3)}.${meio.slice(3, 6)}-**`;
}

// Aplica a máscara a qualquer CPF encontrado dentro de uma string — tanto
// formatado (000.000.000-00) quanto só dígitos (11 seguidos, isolado).
// Reconhecidamente heurístico: um identificador não-CPF de exatamente 11
// dígitos isolados também seria mascarado. Aceito como troca a favor de
// minimização de dado, conforme decisão do usuário.
function mascararCpfEmTexto(texto) {
  if (typeof texto !== 'string' || texto.length < 11) return texto;

  let resultado = texto.replace(
    /\b(\d{3})\.(\d{3})\.(\d{3})-(\d{2})\b/g,
    (_, a, b, c) => `***.${b}.${c}-**`
  );

  resultado = resultado.replace(/(?<!\d)(\d{11})(?!\d)/g, (m) => mascararCpf11Digitos(m));

  return resultado;
}

// Percorre recursivamente qualquer estrutura (objeto/array/string/número) e
// aplica a máscara de CPF em todo valor string encontrado — é isso que
// garante que detalhe_original (JSONB do payload bruto) nunca guarda CPF
// completo, mesmo em campos que não sabíamos de antemão que continham CPF
// (ex.: sancionado.codigoFormatado, achado na exploração do Sprint C1).
function sanitizarPayload(valor) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return mascararCpfEmTexto(valor);
  if (Array.isArray(valor)) return valor.map(sanitizarPayload);
  if (typeof valor === 'object') {
    const saida = {};
    for (const [chave, v] of Object.entries(valor)) saida[chave] = sanitizarPayload(v);
    return saida;
  }
  return valor;
}

// Normaliza CNPJ formatado da API ("36.953.179/0001-49") pro nosso padrão
// interno (cnpj_basico + cnpj_ordem + cnpj_dv, dígitos separados).
function normalizarCnpj(cnpjFormatado) {
  const digitos = (cnpjFormatado || '').replace(/\D/g, '');
  if (digitos.length !== 14) return null;
  return {
    cnpj_basico: digitos.slice(0, 8),
    cnpj_ordem: digitos.slice(8, 12),
    cnpj_dv: digitos.slice(12, 14),
  };
}

// Converte data no formato DD/MM/AAAA (ou "Sem informação") pra Date/NULL.
function parseDataBr(texto) {
  if (!texto || typeof texto !== 'string') return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto.trim());
  if (!m) return null; // cobre "Sem informação" e afins
  const [, dd, mm, aaaa] = m;
  return `${aaaa}-${mm}-${dd}`; // formato ISO, Postgres aceita direto
}

module.exports = { sanitizarPayload, mascararCpfEmTexto, normalizarCnpj, parseDataBr };
