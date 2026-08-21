import React, { useEffect, useState, useCallback } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function Typeahead({ label, placeholder, endpoint, value, onSelect }) {
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const debouncedTerm = useDebounce(term, 300);

  useEffect(() => {
    if (debouncedTerm.trim().length < 2) {
      setOptions([]);
      return;
    }
    fetch(`${API_URL}${endpoint}?search=${encodeURIComponent(debouncedTerm)}`)
      .then((r) => r.json())
      .then((data) => setOptions(data))
      .catch(() => setOptions([]));
  }, [debouncedTerm, endpoint]);

  return (
    <div className="field typeahead-field">
      <label>{label}</label>
      {value ? (
        <div className="chip">
          <span>{value.descricao}</span>
          <button type="button" onClick={() => onSelect(null)} aria-label="Remover filtro">
            ×
          </button>
        </div>
      ) : (
        <div className="typeahead-wrap">
          <input
            type="text"
            placeholder={placeholder}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {open && options.length > 0 && (
            <ul className="typeahead-list">
              {options.map((opt) => (
                <li
                  key={opt.codigo}
                  onMouseDown={() => {
                    onSelect(opt);
                    setTerm('');
                    setOpen(false);
                  }}
                >
                  <span className="opt-codigo">{opt.codigo}</span> {opt.descricao}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [ufs, setUfs] = useState([]);
  const [situacoes, setSituacoes] = useState([]);

  const [uf, setUf] = useState('');
  const [situacaoSelecionadas, setSituacaoSelecionadas] = useState(['02']); // Ativa por padrão
  const [cnae, setCnae] = useState(null);
  const [municipio, setMunicipio] = useState(null);
  const [razaoSocial, setRazaoSocial] = useState('');
  const [temTelefone, setTemTelefone] = useState(false);
  const [temEmail, setTemEmail] = useState(false);
  const [somenteMatriz, setSomenteMatriz] = useState(false);

  const [page, setPage] = useState(1);
  const [resultado, setResultado] = useState({ rows: [], total: 0, totalPages: 0, totalIsExact: true });
  const [loading, setLoading] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/api/ufs`).then((r) => r.json()).then(setUfs).catch(() => {});
    fetch(`${API_URL}/api/situacoes`).then((r) => r.json()).then(setSituacoes).catch(() => {});
  }, []);

  const buildParams = useCallback(
    (extra = {}) => {
      const params = new URLSearchParams();
      if (uf) params.set('uf', uf);
      if (municipio) params.set('municipioCodigo', municipio.codigo);
      if (cnae) params.set('cnaeCodigo', cnae.codigo);
      situacaoSelecionadas.forEach((s) => params.append('situacao', s));
      if (somenteMatriz) params.set('somenteMatriz', 'true');
      if (temTelefone) params.set('temTelefone', 'true');
      if (temEmail) params.set('temEmail', 'true');
      if (razaoSocial.trim()) params.set('razaoSocial', razaoSocial.trim());
      Object.entries(extra).forEach(([k, v]) => params.set(k, v));
      return params;
    },
    [uf, municipio, cnae, situacaoSelecionadas, somenteMatriz, temTelefone, temEmail, razaoSocial]
  );

  const buscar = useCallback(
    (targetPage = 1) => {
      setLoading(true);
      setErro('');
      const params = buildParams({ page: targetPage, pageSize: 25 });
      fetch(`${API_URL}/api/search?${params.toString()}`)
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Erro ao buscar dados');
          setResultado(data);
          setPage(targetPage);
        })
        .catch((err) => setErro(err.message || 'Erro ao buscar dados'))
        .finally(() => setLoading(false));
    },
    [buildParams]
  );

  useEffect(() => {
    buscar(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleSituacao(codigo) {
    setSituacaoSelecionadas((prev) =>
      prev.includes(codigo) ? prev.filter((s) => s !== codigo) : [...prev, codigo]
    );
  }

  function exportar() {
    setExportando(true);
    const params = buildParams();
    const url = `${API_URL}/api/export?${params.toString()}`;
    // Dispara o download navegando para a URL (o backend envia o arquivo
    // com Content-Disposition: attachment, então o navegador baixa direto).
    window.location.href = url;
    setTimeout(() => setExportando(false), 2000);
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Buscador de Empresas</h1>
        <span className="subtitle">
          Base de CNPJs — {resultado.totalIsExact ? '' : 'mais de '}
          {resultado.total.toLocaleString('pt-BR')}
          {resultado.totalIsExact ? '' : '+'} resultados
        </span>
      </header>

      <div className="layout">
        <aside className="filters">
          <div className="field">
            <label>UF</label>
            <select value={uf} onChange={(e) => setUf(e.target.value)}>
              <option value="">Todas</option>
              {ufs.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>

          <Typeahead
            label="Município"
            placeholder="Digite o nome da cidade..."
            endpoint="/api/municipios"
            value={municipio}
            onSelect={setMunicipio}
          />

          <Typeahead
            label="Atividade (CNAE)"
            placeholder="Digite a atividade..."
            endpoint="/api/cnaes"
            value={cnae}
            onSelect={setCnae}
          />

          <div className="field">
            <label>Razão social / Nome fantasia</label>
            <input
              type="text"
              placeholder="Buscar por nome..."
              value={razaoSocial}
              onChange={(e) => setRazaoSocial(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Situação cadastral</label>
            <div className="checkbox-group">
              {situacoes.map((s) => (
                <label key={s.codigo} className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={situacaoSelecionadas.includes(s.codigo)}
                    onChange={() => toggleSituacao(s.codigo)}
                  />
                  {s.descricao}
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={somenteMatriz}
                onChange={(e) => setSomenteMatriz(e.target.checked)}
              />
              Somente matriz (sem filiais)
            </label>
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={temTelefone}
                onChange={(e) => setTemTelefone(e.target.checked)}
              />
              Somente com telefone
            </label>
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={temEmail}
                onChange={(e) => setTemEmail(e.target.checked)}
              />
              Somente com e-mail
            </label>
          </div>

          <button className="btn-primary" onClick={() => buscar(1)} disabled={loading}>
            {loading ? 'Buscando...' : 'Aplicar filtros'}
          </button>
          {erro && <p className="hint hint-erro">{erro}</p>}
          <button className="btn-secondary" onClick={exportar} disabled={exportando || resultado.total === 0}>
            {exportando ? 'Gerando planilha...' : `Exportar planilha (${Math.min(resultado.total, 100000).toLocaleString('pt-BR')} linhas)`}
          </button>
          {resultado.total > 100000 && (
            <p className="hint">Exportação limitada a 100.000 linhas por vez. Refine os filtros para reduzir o resultado.</p>
          )}
        </aside>

        <main className="results">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CNPJ</th>
                  <th>Razão Social</th>
                  <th>Nome Fantasia</th>
                  <th>UF</th>
                  <th>Município</th>
                  <th>Telefone</th>
                  <th>E-mail</th>
                </tr>
              </thead>
              <tbody>
                {resultado.rows.map((row) => (
                  <tr key={row.cnpj}>
                    <td className="mono">{row.cnpj}</td>
                    <td>{row.razao_social}</td>
                    <td>{row.nome_fantasia}</td>
                    <td>{row.uf}</td>
                    <td>{row.municipio_nome}</td>
                    <td className="mono">
                      {row.ddd_1 && row.ddd_1 !== '0' ? `(${row.ddd_1}) ${row.telefone_1}` : '—'}
                    </td>
                    <td>{row.correio_eletronico || '—'}</td>
                  </tr>
                ))}
                {!loading && resultado.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      Nenhum resultado para os filtros atuais.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button disabled={page <= 1 || loading} onClick={() => buscar(page - 1)}>
              Anterior
            </button>
            <span>
              Página {page} de {resultado.totalPages || 1}
            </span>
            <button disabled={page >= resultado.totalPages || loading} onClick={() => buscar(page + 1)}>
              Próxima
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
