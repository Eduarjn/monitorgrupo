/** Contexto de sessão: quem está logado e como sair. */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, token, type Usuario } from './api.ts';

interface Sessao {
  usuario: Usuario | null;
  carregando: boolean;
  entrar: (email: string, senha: string) => Promise<void>;
  sair: () => void;
}

const Ctx = createContext<Sessao>(null as unknown as Sessao);
export const useSessao = () => useContext(Ctx);

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [carregando, setCarregando] = useState(true);

  // Revalida o token guardado ao abrir: token vencido não deve mostrar a tela.
  useEffect(() => {
    if (!token.ler()) { setCarregando(false); return; }
    api.eu().then((r) => setUsuario(r.usuario))
            .catch(() => token.limpar())
            .finally(() => setCarregando(false));
  }, []);

  const entrar = async (email: string, senha: string) => {
    const r = await api.login(email, senha);
    token.gravar(r.token);
    setUsuario(r.usuario);
  };
  const sair = () => { token.limpar(); setUsuario(null); };

  return <Ctx.Provider value={{ usuario, carregando, entrar, sair }}>{children}</Ctx.Provider>;
}
