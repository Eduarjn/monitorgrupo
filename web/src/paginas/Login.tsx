import { useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { useSessao } from '../lib/auth.tsx';
import { Aviso, Botao, Campo } from '../componentes/ui.tsx';

export default function Login() {
  const { entrar } = useSessao();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro(''); setEnviando(true);
    try { await entrar(email, senha); }
    catch (x) { setErro((x as Error).message); }
    finally { setEnviando(false); }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-secondary px-4">
      {/* brilho Fulor sutil ao fundo, marca da estética industrial-tech */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2
                      rounded-full bg-primary/10 blur-[120px]" />

      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-primary shadow-glow">
            <MessageSquareText className="h-7 w-7 text-primary-foreground" />
          </span>
          <div className="font-display text-[11px] font-bold uppercase tracking-[4px] text-aqua">
            ERA · Inteligência de conversas
          </div>
          <h1 className="mt-1 font-display text-4xl font-black uppercase leading-none tracking-wide">
            Monitor de Grupos
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Análise de histórico de WhatsApp com IA
          </p>
        </div>

        <form onSubmit={submeter}
              className="space-y-4 rounded-xl border border-border bg-background p-6">
          <Campo label="E-mail" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} />
          <Campo label="Senha" type="password" autoComplete="current-password" required
                 value={senha} onChange={(e) => setSenha(e.target.value)} />
          {erro && <Aviso tipo="erro">{erro}</Aviso>}
          <Botao type="submit" disabled={enviando} className="w-full">
            {enviando ? 'Entrando…' : 'Entrar'}
          </Botao>
        </form>

        <p className="mt-6 text-center font-display text-[10px] font-semibold uppercase tracking-[3px] text-muted-foreground">
          era.com.br
        </p>
      </div>
    </div>
  );
}
