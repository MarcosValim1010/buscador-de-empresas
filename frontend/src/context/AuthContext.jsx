import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getSession } from '../lib/api.js';

const AuthContext = createContext(null);
const STORAGE_KEY = 'aveudata-token';

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [account, setAccount] = useState(null);
  const [authReady, setAuthReady] = useState(() => !localStorage.getItem(STORAGE_KEY));

  useEffect(() => {
    if (!token) {
      setAccount(null);
      setAuthReady(true);
      return undefined;
    }

    let cancelled = false;
    setAuthReady(false);
    getSession(token)
      .then((data) => {
        if (!cancelled) setAccount(data.account);
      })
      .catch(() => {
        if (!cancelled) {
          localStorage.removeItem(STORAGE_KEY);
          setTokenState('');
          setAccount(null);
        }
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const setToken = useCallback((newToken) => {
    if (newToken) {
      localStorage.setItem(STORAGE_KEY, newToken);
      setAuthReady(false);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      setAuthReady(true);
    }
    setAccount(null);
    setTokenState(newToken || '');
  }, []);

  const logout = useCallback(() => setToken(''), [setToken]);

  useEffect(() => {
    window.addEventListener('aveudata:unauthorized', logout);
    return () => window.removeEventListener('aveudata:unauthorized', logout);
  }, [logout]);

  const value = useMemo(
    () => ({ token, account, authReady, setToken, logout }),
    [token, account, authReady, setToken, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
