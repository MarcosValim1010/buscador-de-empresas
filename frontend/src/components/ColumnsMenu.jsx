import React, { useEffect, useRef, useState } from 'react';
import { Columns3, ChevronDown } from 'lucide-react';
import './ColumnsMenu.css';

export default function ColumnsMenu({ columns, visible, onToggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="columns-menu" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
        <Columns3 size={14} />
        Colunas
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="columns-menu-dropdown">
          {columns.map((col) => (
            <label key={col.key} className="columns-menu-item">
              <input
                type="checkbox"
                checked={visible.includes(col.key)}
                disabled={col.locked}
                onChange={() => onToggle(col.key)}
              />
              <span>{col.label}</span>
              {col.group && <span className="columns-menu-group">{col.group}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
