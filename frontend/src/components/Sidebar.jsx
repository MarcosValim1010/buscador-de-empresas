import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Search,
  ListChecks,
  Database,
  BarChart3,
  Settings,
  ChevronDown,
  Triangle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/buscar-empresas', label: 'Buscar Empresas', icon: Search },
  { to: '/listas', label: 'Listas', icon: ListChecks },
  { to: '/enriquecimento', label: 'Enriquecimento', icon: Database },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3 },
];

const PLANO_LABELS = {
  trial: 'Teste grátis',
  paid: 'Plano Pago',
};

export default function Sidebar() {
  const { account } = useAuth();

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="sidebar-logo-mark">
          <Triangle size={16} strokeWidth={0} fill="currentColor" />
        </span>
        <span className="sidebar-logo-text">AveuData</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
          >
            <Icon size={17} strokeWidth={1.75} />
            <span>{label}</span>
          </NavLink>
        ))}

        <NavLink
          to="/configuracoes"
          className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
        >
          <Settings size={17} strokeWidth={1.75} />
          <span>Configurações</span>
          <ChevronDown size={14} className="sidebar-nav-chevron" />
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <div className="plan-card">
          <div className="plan-card-label">Plano Atual</div>
          <div className="plan-card-name">
            {PLANO_LABELS[account.plano] || account.plano}
          </div>
          <div className="plan-card-sub">Limite de exportação</div>
          <div className="plan-card-value">
            {account.exportMaxRows?.toLocaleString('pt-BR')} linhas
          </div>
        </div>

        <NavLink to="/configuracoes" className="sidebar-user">
          <span className="sidebar-avatar">
            AD
          </span>
          <span className="sidebar-user-info">
            <span className="sidebar-user-name">
              Conta #{account.accountId}
            </span>
            <span className="sidebar-user-role">Administrador</span>
          </span>
        </NavLink>
      </div>
    </aside>
  );
}
