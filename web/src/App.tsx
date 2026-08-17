import { useEffect, useState } from 'react';
import {
  BarChart3, LogOut, MessageSquareText, Plug, Search, ShieldCheck, UploadCloud,
} from 'lucide-react';
import { api, type Grupo } from './lib/api.ts';
import { useSessao } from './lib/auth.tsx';
import { Aviso, Carregando } from './componentes/ui.tsx';
import Login from './paginas/Login.tsx';
import Dashboard from './paginas/Dashboard.tsx';
import Upload from './paginas/Upload.tsx';
import Analise from './paginas/Analise.tsx';
import Consentimento from './paginas/Consentimento.tsx';
import Coleta from './paginas/Coleta.tsx';

type Aba = 'dashboard' | 'analise' | 'upload' | 'coleta' | 'lgpd';

const ABAS: Array<{ id: Aba; rotulo: string; Icone: typeof BarChart3 }> = [
  { id: 'dashboard', rotulo: 'Dashboard', Icone: BarChart3 },
  { id: 'analise', rotulo: 'Resumo e busca', Icone: Search },
  { id: 'upload', rotulo: 'Upload', Icone: UploadCloud },
  { id: 'coleta', rotulo: 'Coleta', Icone: Plug },
  { id: 'lgpd', rotulo: 'Consentimento', Icone: ShieldCheck },
];

export default function App() {
  const { usuario, carregando, sair } = useSessao();
  const [grupos, setGrupos] = useState<Grupo[] | null>(null);
  const [grupoId, setGrupoId] = useState<number | null>(null);
  const [aba, setAba] = useState<Aba>('dashboard');
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!usuario) return;
    api.grupos()
      .then((r) => {
        setGrupos(r.grupos);
        setGrupoId((atual) => atual ?? r.grupos[0]?.id ?? null);
      })
      .catch((e) => setErro((e as Error).message));
  }, [usuario]);

  if (carregando) return <Carregando texto="verificando sessão…" />;
  if (!usuario) return <Login />;

  const grupo = grupos?.find((g) => g.id === grupoId) ?? null;
  const podeGerir = !!grupo && ['gestor', 'admin'].includes(grupo.papel);

  return (
    <div className="min-h-screen bg-secondary">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary">
              <MessageSquareText className="h-5 w-5 text-primary-foreground" />
            </span>
            <div className="leading-tight">
              <span className="block font-display text-lg font-extrabold uppercase tracking-wide">
                Monitor de Grupos
              </span>
              <span className="block font-display text-[10px] font-bold uppercase tracking-[4px] text-aqua">
                ERA · Inteligência de conversas
              </span>
            </div>
          </div>

          {grupos && grupos.length > 0 && (
            <select
              value={grupoId ?? ''}
              onChange={(e) => setGrupoId(Number(e.target.value))}
              className="rounded-lg border border-border bg-white/5 px-3 py-1.5 text-sm
                         outline-none focus:border-primary/60"
            >
              {grupos.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome} ({g.mensagens.toLocaleString('pt-BR')})
                </option>
              ))}
            </select>
          )}

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline">{usuario.email}</span>
            <button onClick={sair} title="Sair"
                    className="rounded-lg border border-border p-1.5 text-muted-foreground
                               transition hover:border-primary/50 hover:text-primary">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mx-auto max-w-6xl overflow-x-auto px-4">
          <nav className="flex gap-1">
            {ABAS.map(({ id, rotulo, Icone }) => (
              <button
                key={id}
                onClick={() => setAba(id)}
                className={
                  'flex items-center gap-2 border-b-2 px-3 py-2.5 font-display text-sm font-semibold uppercase tracking-wider transition ' +
                  (aba === id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground')
                }
              >
                <Icone className="h-4 w-4" />
                {rotulo}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {erro && <Aviso tipo="erro">{erro}</Aviso>}

        {!erro && grupos && grupos.length === 0 && (
          <Aviso>
            Você ainda não tem acesso a nenhum grupo. Peça a um administrador para liberar
            seu usuário em <b>grupo_acessos</b>.
          </Aviso>
        )}

        {/* Coleta é dado de CONTA, não de grupo: o canal de aviso é um só e o
            painel de saúde cobre todos os grupos. Por isso fica fora do
            `grupo &&` — senão a tela ficaria em branco sem grupo selecionado. */}
        {aba === 'coleta' && (
          <Coleta grupo={grupo?.id ?? 0} podeGerir={podeGerir}
                  ehAdmin={usuario.papel_global === 'admin'} />
        )}

        {grupo && aba !== 'coleta' && (
          <>
            {aba === 'dashboard' && <Dashboard grupo={grupo.id} />}
            {aba === 'analise' && <Analise grupo={grupo.id} grupoNome={grupo.nome} />}
            {aba === 'upload' && <Upload grupo={grupo.id} />}
            {aba === 'lgpd' && (
              <Consentimento grupo={grupo.id} grupoNome={grupo.nome} podeGerir={podeGerir} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
