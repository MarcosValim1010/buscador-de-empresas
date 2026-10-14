import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Filter,
  Bookmark,
  Download,
  Database,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  SearchIcon,
} from 'lucide-react';
import MultiSelect from '../components/MultiSelect.jsx';
import ColumnsMenu from '../components/ColumnsMenu.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import {
  getUfs,
  getSituacoes,
  getTiposEmpresa,
  getMunicipios,
  searchEmpresas,
  downloadExport,
} from '../lib/api.js';
import { COLUMN_DEFS, DEFAULT_VISIBLE_COLUMNS } from '../lib/columns.js';
import './BuscarEmpresas.css';

const VISIBLE_COLS_KEY = 'aveudata-visible-columns';
const PAGE_SIZE = 20;
const SITUACAO_PADRAO = ['02']; // Ativa

function loadVisibleColumns() {
  try {
    const stored = JSON.parse(localStorage.getItem(VISIBLE_COLS_KEY));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // ignore
  }
  return DEFAULT_VISIBLE_COLUMNS;
}

export default function BuscarEmpresas() {
  const { token, account } = useAuth();

  const [ufs, setUfs] = useState([]);
  const [situacoes, setSituacoes] = useState([]);

  const [uf, setUf] = useState('');
  const [situacaoSelecionadas, setSituacaoSelecionadas] = useState(SITUACAO_PADRAO);
  const [tiposEmpresa, setTiposEmpresa] = useState([]);
  const [municipios, setMunicipios] = useState([]);
  const [razaoSocial, setRazaoSocial] = useState('');
  const [temTelefone, setTemTelefone] = useState(false);
  const [temEmail, setTemEmail] = useState(false);
  const [somenteMatriz, setSomenteMatriz] = useState(false);

  const [page, setPage] = useState(1);
  const [resultado, setResultado] = useState({ rows: [], total: 0, totalPages: 0, totalIsExact: true });
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');

  const [visibleCols, setVisibleCols] = useState(loadVisibleColumns);
  const [exportando, setExportando] = useState(false);

  useEffect(() => {
    getUfs().then(setUfs).catch(() => {});
    getSituacoes().then(setSituacoes).catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem(VISIBLE_COLS_KEY, JSON.stringify(visibleCols));
  }, [visibleCols]);

  const filters = useMemo(
    () => ({
      uf,
      municipios,
      tiposEmpresa,
      situacoes: situacaoSelecionadas,
      somenteMatriz,
      temTelefone,
      temEmail,
      razaoSocial,
    }),
    [uf, municipios, tiposEmpresa, situacaoSelecionadas, somenteMatriz, temTelefone, temEmail, razaoSocial]
  );

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (uf) n++;
    if (municipios.length) n++;
    if (tiposEmpresa.length) n++;
    if (razaoSocial.trim()) n++;
    if (somenteMatriz) n++;
    if (temTelefone) n++;
    if (temEmail) n++;
    if (
      situacaoSelecionadas.length !== SITUACAO_PADRAO.length ||
      situacaoSelecionadas.some((s) => !SITUACAO_PADRAO.includes(s))
    ) {
      n++;
    }
    return n;
  }, [uf, municipios, tiposEmpresa, razaoSocial, somenteMatriz, temTelefone, temEmail, situacaoSelecionadas]);

  const buscar = useCallback(
    (targetPage = 1) => {
      setLoading(true);
      setErro('');
      searchEmpresas(filters, { page: targetPage, pageSize: PAGE_SIZE, token })
        .then((data) => {
          setResultado(data);
          setPage(targetPage);
        })
        .catch((err) => setErro(err.message || 'Erro ao buscar dados'))
        .finally(() => setLoading(false));
    },
    [filters, token]
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

  function limparFiltros() {
    setUf('');
    setMunicipios([]);
    setTiposEmpresa([]);
    setRazaoSocial('');
    setSomenteMatriz(false);
    setTemTelefone(false);
    setTemEmail(false);
    setSituacaoSelecionadas(SITUACAO_PADRAO);
  }

  function toggleColumn(key) {
    setVisibleCols((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function abrirExportacao() {
    setErro('');
    setExportando(true);
    try {
      await downloadExport(filters, { token });
    } catch (err) {
      setErro(err.message || 'Erro ao gerar planilha');
    } finally {
      setExportando(false);
    }
  }

  const exportCount = Math.min(resultado.total, account.exportMaxRows);
  const columns = COLUMN_DEFS.filter((c) => visibleCols.includes(c.key));
  const rangeStart = resultado.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, resultado.total);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Buscar Empresas</h1>
          <p className="page-subtitle">
            Base de CNPJs — {resultado.totalIsExact ? '' : 'mais de '}
            {resultado.total.toLocaleString('pt-BR')}
            {resultado.totalIsExact ? '' : '+'} resultados
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn" disabled title="Em breve">
            <Bookmark size={15} />
            Salvar busca
          </button>
          <button
            className="btn btn-primary"
            onClick={abrirExportacao}
            disabled={resultado.total === 0 || exportando}
          >
            <Download size={15} />
            {exportando ? 'Gerando planilha...' : 'Exportar planilha'}
          </button>
        </div>
      </header>

      <section className="card">
        <div className="card-header">
          <Filter size={15} />
          <h2>Filtros de busca</h2>
        </div>

        <div className="filters-grid">
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

          <MultiSelect
            label="Município"
            placeholder="Buscar município..."
            fetcher={getMunicipios}
            value={municipios}
            onChange={setMunicipios}
          />

          <MultiSelect
            label="Tipo de empresa"
            placeholder="Ex.: restaurantes, loja de informática..."
            searchPlaceholder="Digite o tipo de empresa..."
            emptyMessage="Nenhum tipo de empresa encontrado. Tente outro termo."
            fetcher={getTiposEmpresa}
            value={tiposEmpresa}
            onChange={setTiposEmpresa}
            showCode={false}
          />

          <div className="field filters-grid-span3">
            <label>Razão Social / Nome Fantasia</label>
            <input
              type="text"
              placeholder="Buscar por nome, razão social ou fantasia..."
              value={razaoSocial}
              onChange={(e) => setRazaoSocial(e.target.value)}
            />
          </div>

          <div className="field filters-grid-span3">
            <label>Situação Cadastral</label>
            <div className="checkbox-row">
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
                <input type="checkbox" checked={temEmail} onChange={(e) => setTemEmail(e.target.checked)} />
                Somente com e-mail
              </label>
            </div>
          </div>
        </div>

        {erro && <p className="hint hint-erro filters-erro">{erro}</p>}

        <div className="filters-footer">
          <div className="filters-footer-left">
            <span className="badge">Filtros ativos: {activeFilterCount}</span>
            <button className="btn btn-ghost btn-sm" onClick={limparFiltros}>
              <RotateCcw size={13} />
              Limpar filtros
            </button>
          </div>
          <div className="filters-footer-right">
            <button
              className="btn"
              onClick={abrirExportacao}
              disabled={resultado.total === 0 || exportando}
            >
              <Download size={14} />
              {exportando
                ? 'Gerando planilha...'
                : `Exportar planilha (${exportCount.toLocaleString('pt-BR')} linhas)`}
            </button>
            <button className="btn btn-primary" onClick={() => buscar(1)} disabled={loading}>
              <SearchIcon size={14} />
              {loading ? 'Buscando...' : 'Aplicar filtros'}
            </button>
          </div>
        </div>
      </section>

      <section className="card results-card">
        <div className="card-header results-card-header">
          <div className="results-card-title">
            <Database size={15} />
            <h2>Resultados da busca</h2>
            <span className="badge">
              {resultado.totalIsExact ? resultado.total.toLocaleString('pt-BR') : `${resultado.total.toLocaleString('pt-BR')}+`}
            </span>
          </div>
          <div className="results-card-tools">
            <ColumnsMenu columns={COLUMN_DEFS} visible={visibleCols} onToggle={toggleColumn} />
            <span className="results-range">
              {rangeStart.toLocaleString('pt-BR')}–{rangeEnd.toLocaleString('pt-BR')} de{' '}
              {resultado.totalIsExact ? resultado.total.toLocaleString('pt-BR') : `${resultado.total.toLocaleString('pt-BR')}+`}
            </span>
            <button className="btn btn-sm" disabled={page <= 1 || loading} onClick={() => buscar(page - 1)}>
              <ChevronLeft size={14} />
            </button>
            <button
              className="btn btn-sm"
              disabled={page >= resultado.totalPages || loading}
              onClick={() => buscar(page + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resultado.rows.map((row) => (
                <tr key={row.cnpj}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.mono ? 'mono' : undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
              {!loading && resultado.rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="empty">
                    Nenhum resultado para os filtros atuais.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

    </>
  );
}
