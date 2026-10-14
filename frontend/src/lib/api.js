export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function getJson(path, { token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API_URL}${path}`, { headers });
  const data = await r.json();
  if (r.status === 401 && token) window.dispatchEvent(new Event('aveudata:unauthorized'));
  if (!r.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

export function getUfs() {
  return getJson('/api/ufs');
}

export function getSituacoes() {
  return getJson('/api/situacoes');
}

export function getCnaes(search) {
  return getJson(`/api/cnaes?search=${encodeURIComponent(search)}`);
}

export function getTiposEmpresa(search) {
  return getJson(`/api/tipos-empresa?search=${encodeURIComponent(search)}`);
}

export function getMunicipios(search) {
  return getJson(`/api/municipios?search=${encodeURIComponent(search)}`);
}

export function login(email, senha) {
  return fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erro ao autenticar.');
    return data;
  });
}

export function getSession(token) {
  return getJson('/api/auth/me', { token });
}

export function buildSearchParams(filters, extra = {}) {
  const params = new URLSearchParams();
  if (filters.uf) params.set('uf', filters.uf);
  (filters.municipios || []).forEach((m) => params.append('municipioCodigo', m.codigo));
  // O usuário escolhe tipos de empresa; o código CNAE correspondente é
  // apenas o identificador interno usado pela base da Receita Federal.
  (filters.tiposEmpresa || filters.cnaes || []).forEach((tipo) => {
    const codigos = Array.isArray(tipo.codigos) && tipo.codigos.length
      ? tipo.codigos
      : [tipo.codigo];
    codigos.forEach((codigo) => params.append('cnaeCodigo', codigo));
  });
  (filters.situacoes || []).forEach((s) => params.append('situacao', s));
  if (filters.somenteMatriz) params.set('somenteMatriz', 'true');
  if (filters.temTelefone) params.set('temTelefone', 'true');
  if (filters.temEmail) params.set('temEmail', 'true');
  if (filters.razaoSocial && filters.razaoSocial.trim()) {
    params.set('razaoSocial', filters.razaoSocial.trim());
  }
  Object.entries(extra).forEach(([k, v]) => params.set(k, v));
  return params;
}

export async function searchEmpresas(filters, { page = 1, pageSize = 20, token } = {}) {
  const params = buildSearchParams(filters, { page, pageSize });
  return getJson(`/api/search?${params.toString()}`, { token });
}

export async function downloadExport(filters, { token } = {}) {
  const params = buildSearchParams(filters);
  const r = await fetch(`${API_URL}/api/export?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) window.dispatchEvent(new Event('aveudata:unauthorized'));
    throw new Error(data.error || 'Erro ao gerar planilha.');
  }

  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'empresas.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
