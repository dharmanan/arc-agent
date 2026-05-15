import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { setToken, getToken, agents } from '../lib/api.js';

const AgentContext = createContext(null);

export function AgentProvider({ children }) {
  const [agent, setAgentState] = useState(null);
  const [jwt,   setJwtState]   = useState(() => getToken());

  const setAgent = useCallback((a) => setAgentState(a), []);

  const setJwt = useCallback((t) => {
    setToken(t);
    setJwtState(t);
  }, []);

  // Clear only the JWT session (agent record stays in DB, user can reconnect via passkey)
  const disconnectSession = useCallback(() => {
    setAgentState(null);
    setToken(null);
    setJwtState(null);
  }, []);

  // Clear JWT + agent state (used after deletion)
  const clearAgent = useCallback(() => {
    setAgentState(null);
    setToken(null);
    setJwtState(null);
  }, []);

  useEffect(() => {
    if (!jwt || agent) return;

    let cancelled = false;

    async function hydrateAgent() {
      try {
        const list = await agents.list();
        const firstAgent = list[0] || null;

        if (!cancelled) {
          if (!firstAgent?.id) {
            setAgentState(null);
            return;
          }

          try {
            const fullAgent = await agents.get(firstAgent.id);
            if (!cancelled) {
              setAgentState(fullAgent || firstAgent);
            }
          } catch {
            if (!cancelled) {
              setAgentState(firstAgent);
            }
          }
        }
      } catch {
        if (!cancelled) {
          setAgentState(null);
          setToken(null);
          setJwtState(null);
        }
      }
    }

    hydrateAgent();

    return () => {
      cancelled = true;
    };
  }, [agent, jwt]);

  return (
    <AgentContext.Provider value={{ agent, setAgent, jwt, setJwt, clearAgent, disconnectSession, isAuthenticated: !!jwt }}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used inside AgentProvider');
  return ctx;
}
