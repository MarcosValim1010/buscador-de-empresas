import React from 'react';
import { Sun, Moon, LogOut } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './Configuracoes.css';

export default function Configuracoes() {
  const { theme, toggleTheme } = useTheme();
  const { account, logout } = useAuth();

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Configurações</h1>
          <p className="page-subtitle">Preferências de exibição e conta.</p>
        </div>
      </header>

      <div className="card settings-card">
        <div className="card-header">
          <h2>Aparência</h2>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Tema</div>
            <div className="settings-row-sub">Alterne entre os temas claro e escuro da interface.</div>
          </div>
          <button className="btn theme-switch" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            {theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
          </button>
        </div>
      </div>

      <div className="card settings-card">
        <div className="card-header">
          <h2>Conta</h2>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Conta #{account.accountId}</div>
            <div className="settings-row-sub">
              Plano: {account.plano} · Limite de exportação: {account.exportMaxRows?.toLocaleString('pt-BR')} linhas
            </div>
          </div>
          <button className="btn" onClick={logout}>
            <LogOut size={15} />
            Sair
          </button>
        </div>
      </div>
    </>
  );
}
