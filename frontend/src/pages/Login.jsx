import React, { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LogIn, Triangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { login } from '../lib/api.js';
import './Login.css';

export default function Login() {
  const { token, account, authReady, setToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  if (!authReady) {
    return <div className="auth-loading">Validando sessão...</div>;
  }
  if (token && account) {
    return <Navigate to="/buscar-empresas" replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    setCarregando(true);
    try {
      const data = await login(email, senha);
      setToken(data.token);
      const destino = location.state?.from || '/buscar-empresas';
      navigate(destino, { replace: true });
    } catch (err) {
      setErro(err.message || 'Não foi possível entrar.');
    } finally {
      setCarregando(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand">
          <span className="login-brand-mark">
            <Triangle size={20} strokeWidth={0} fill="currentColor" />
          </span>
          <span>AveuData</span>
        </div>
        <div className="login-heading">
          <h1>Entre na sua conta</h1>
          <p>Acesse a busca de empresas e exporte conforme o limite do seu plano.</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="login-email">E-mail</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="login-senha">Senha</label>
            <input
              id="login-senha"
              type="password"
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
            />
          </div>
          {erro && <p className="hint hint-erro login-error">{erro}</p>}
          <button className="btn btn-primary login-submit" type="submit" disabled={carregando}>
            <LogIn size={16} />
            {carregando ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
        <p className="login-footnote">Seu acesso e limite de exportação são definidos pelo plano da conta.</p>
      </section>
    </main>
  );
}
