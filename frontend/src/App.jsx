import React from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import BuscarEmpresas from './pages/BuscarEmpresas.jsx';
import Configuracoes from './pages/Configuracoes.jsx';
import Login from './pages/Login.jsx';
import Placeholder from './pages/Placeholder.jsx';
import { useAuth } from './context/AuthContext.jsx';

function RequireAuth() {
  const { token, account, authReady } = useAuth();
  const location = useLocation();

  if (!authReady) {
    return <div className="auth-loading">Validando sessão...</div>;
  }
  if (!token || !account) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/buscar-empresas" replace />} />
          <Route path="buscar-empresas" element={<BuscarEmpresas />} />
          <Route path="configuracoes" element={<Configuracoes />} />
          <Route
            path="dashboard"
            element={
              <Placeholder
                title="Dashboard"
                description="O painel com indicadores gerais ainda está em desenvolvimento no backend. Volte em breve."
              />
            }
          />
          <Route
            path="listas"
            element={
              <Placeholder
                title="Listas"
                description="Salvar e organizar empresas em listas ainda não está disponível. Volte em breve."
              />
            }
          />
          <Route
            path="enriquecimento"
            element={
              <Placeholder
                title="Enriquecimento"
                description="A área de gerenciamento de enriquecimento de dados ainda está em desenvolvimento. Volte em breve."
              />
            }
          />
          <Route
            path="relatorios"
            element={
              <Placeholder
                title="Relatórios"
                description="A geração de relatórios ainda está em desenvolvimento. Volte em breve."
              />
            }
          />
          <Route path="*" element={<Navigate to="/buscar-empresas" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
