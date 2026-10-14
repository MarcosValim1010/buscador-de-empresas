import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import './MultiSelect.css';

function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Multi-select com busca embutida: dropdown com campo de texto que filtra a
// lista (via fetcher assíncrono, debounced) e checkboxes pra marcar mais de
// uma opção. `value` é um array de {codigo, descricao}; `onChange` recebe o
// array atualizado.
export default function MultiSelect({
  label,
  placeholder,
  searchPlaceholder = 'Digite para buscar...',
  emptyMessage = 'Nenhum resultado.',
  showCode = true,
  fetcher,
  value,
  onChange,
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const debouncedTerm = useDebounce(term, 300);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    if (debouncedTerm.trim().length < 2) {
      setOptions([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    fetcher(debouncedTerm)
      .then((data) => {
        if (!cancelled) setOptions(data);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedTerm, fetcher, open]);

  function isSelected(codigo) {
    return value.some((v) => v.codigo === codigo);
  }

  function toggleOption(opt) {
    if (isSelected(opt.codigo)) {
      onChange(value.filter((v) => v.codigo !== opt.codigo));
    } else {
      onChange([...value, opt]);
    }
  }

  function removeOption(codigo, e) {
    e.stopPropagation();
    onChange(value.filter((v) => v.codigo !== codigo));
  }

  // Mescla os selecionados no topo da lista (mesmo fora do resultado da
  // busca atual) com as opções encontradas, sem duplicar.
  const optionsToShow = [
    ...value,
    ...options.filter((o) => !isSelected(o.codigo)),
  ];

  return (
    <div className="field multiselect" ref={ref}>
      <label>{label}</label>
      <button type="button" className="multiselect-trigger" onClick={() => setOpen((o) => !o)}>
        {value.length === 0 ? (
          <span className="multiselect-placeholder">{placeholder}</span>
        ) : (
          <span className="multiselect-summary">
            {value.length === 1 ? value[0].descricao : `${value.length} selecionados`}
          </span>
        )}
        <ChevronDown size={14} />
      </button>

      {value.length > 0 && (
        <div className="multiselect-chips">
          {value.map((v) => (
            <span className="chip chip-sm" key={v.codigo}>
              <span>{v.descricao}</span>
              <button type="button" onClick={(e) => removeOption(v.codigo, e)} aria-label="Remover">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="multiselect-dropdown">
          <div className="multiselect-search">
            <Search size={14} />
            <input
              ref={inputRef}
              type="text"
              placeholder={searchPlaceholder}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </div>
          <div className="multiselect-list">
            {term.trim().length < 2 && value.length === 0 && (
              <div className="multiselect-hint">Digite ao menos 2 letras para buscar.</div>
            )}
            {loading && <div className="multiselect-hint">Buscando...</div>}
            {!loading &&
              optionsToShow.map((opt) => (
                <label key={opt.codigo} className="multiselect-item">
                  <input
                    type="checkbox"
                    checked={isSelected(opt.codigo)}
                    onChange={() => toggleOption(opt)}
                  />
                  {showCode && <span className="opt-codigo">{opt.codigo}</span>}
                  <span>{opt.descricao}</span>
                </label>
              ))}
            {!loading && term.trim().length >= 2 && optionsToShow.length === 0 && (
              <div className="multiselect-hint">{emptyMessage}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
