import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Plug, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { api, type Conexao, type SaudeColeta } from '../lib/api.ts';
import { Aviso, Botao, Card, Carregando, Titulo } from '../componentes/ui.tsx';

/**
 * Coleta assistida (D7). O export continua sendo um clique no celular — não
 * existe caminho oficial para ler grupo por API. O que esta tela automatiza é
 * tudo em volta: cobrar quem atrasou, por qual canal, e com que cadência.
 */

const FREQ: Array<{ v: 'diaria' | 'semanal' | 'manual'; r: string }> = [
  { v: 'semanal', r: 'Semanal' },
  { v: 'diaria', r: 'Diária' },
  { v: 'manual', r: 'Sem cobrança' },
];

const dataCurta = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—';

function Selo({ g }: { g: SaudeColeta }) {
  if (g.frequencia_coleta === 'manual') {
    return <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">sem cobrança</span>;
  }
  if (g.nunca_coletado) {
    return <span className="rounded-full border border-aqua/50 bg-aqua/10 px-2 py-0.5 text-[11px] text-aqua">nunca coletado</span>;
  }
  if (g.atrasado) {
    return <span className="rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">atrasado</span>;
  }
  return <span className="rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">em dia</span>;
}

export default function Coleta({ grupo, podeGerir, ehAdmin }: {
  grupo: number; podeGerir: boolean; ehAdmin: boolean;
}) {
  const [saude, setSaude] = useState<SaudeColeta[] | null>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = () =>
    api.saudeColeta().then((r) => setSaude(r.grupos)).catch((e) => setErro((e as Error).message));

  useEffect(() => { carregar(); }, []);

  // Number nos dois lados: defesa contra id que volte como string do banco.
  const atual = saude?.find((g) => Number(g.grupo_id) === Number(grupo)) ?? null;

  const [freq, setFreq] = useState<'diaria' | 'semanal' | 'manual'>('semanal');
  const [ativo, setAtivo] = useState(false);
  const [destino, setDestino] = useState('');

  // Reflete o grupo selecionado no cabeçalho sempre que ele (ou o dado) mudar.
  useEffect(() => {
    if (!atual) return;
    setFreq(atual.frequencia_coleta);
    setAtivo(atual.lembrete_ativo);
    setDestino(atual.lembrete_destino ?? '');
  }, [atual?.grupo_id, atual?.frequencia_coleta, atual?.lembrete_ativo, atual?.lembrete_destino]);

  const rodar = async (fn: () => Promise<string>) => {
    setErro(''); setOk(''); setSalvando(true);
    try { setOk(await fn()); await carregar(); }
    catch (e) { setErro((e as Error).message); }
    finally { setSalvando(false); }
  };

  if (!saude) return <Carregando texto="lendo a saúde da coleta…" />;

  const atrasados = saude.filter((g) => g.atrasado);

  return (
    <div className="space-y-6">
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {ok && <Aviso tipo="ok">{ok}</Aviso>}

      <Aviso>
        <div className="flex gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-aqua" />
          <span>
            <b>Não existe conexão automática que leia grupos.</b> Nem por QR Code, nem pela API
            oficial da Meta — o WhatsApp é criptografado ponta a ponta e o histórico só existe no
            aparelho. O export continua sendo um clique no celular; o que o painel automatiza é
            lembrar, cobrar, processar e resumir.
          </span>
        </div>
      </Aviso>

      {/* ---------------- painel de saúde ---------------- */}
      <Card>
        <Titulo sub={atrasados.length
          ? `${atrasados.length} ${atrasados.length === 1 ? 'grupo precisa' : 'grupos precisam'} de coleta.`
          : 'Todos os grupos estão dentro da cadência configurada.'}>
          Saúde da coleta
        </Titulo>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2">Grupo</th><th>Situação</th>
                <th className="text-right">Sem coletar</th>
                <th className="text-right">Última</th><th className="text-right">Próxima</th>
                <th>Lembrete</th>
              </tr>
            </thead>
            <tbody>
              {saude.map((g) => (
                <tr key={g.grupo_id}
                    className={'border-t border-border ' +
                               (Number(g.grupo_id) === Number(grupo) ? 'bg-white/5' : '')}>
                  <td className="py-2 font-medium">{g.nome}</td>
                  <td><Selo g={g} /></td>
                  <td className="text-right tabular-nums">
                    {g.dias_sem_coleta == null ? '—' : `${g.dias_sem_coleta} d`}
                  </td>
                  <td className="text-right text-muted-foreground">{dataCurta(g.ultima_coleta_em)}</td>
                  <td className="text-right text-muted-foreground">{dataCurta(g.proxima_coleta_em)}</td>
                  <td className="text-muted-foreground">
                    {g.lembrete_ativo
                      ? <span className="inline-flex items-center gap-1 text-primary">
                          <CheckCircle2 className="h-3.5 w-3.5" />ligado
                        </span>
                      : 'desligado'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---------------- configuração do grupo ---------------- */}
      <Card>
        <Titulo sub="Vale para o grupo selecionado no topo da página.">
          Cobrança deste grupo
        </Titulo>

        {!atual ? (
          <p className="text-sm text-muted-foreground">Selecione um grupo no topo da página.</p>
        ) : !podeGerir ? (
          <Aviso>Só um gestor deste grupo pode alterar a cobrança.</Aviso>
        ) : (
          <div className="space-y-4">
            {!atual.consentimento_ok && (
              <Aviso tipo="erro">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Este grupo não tem aviso de consentimento registrado. O lembrete automático
                    fica bloqueado até você registrar o aviso na aba <b>Consentimento</b> —
                    é o que a LGPD exige antes de automatizar.
                  </span>
                </div>
              </Aviso>
            )}

            <div className="flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
                  Cadência
                </span>
                <select value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}
                        className="rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60">
                  {FREQ.map((f) => <option key={f.v} value={f.v}>{f.r}</option>)}
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
                  Quem recebe o lembrete
                </span>
                <input value={destino} onChange={(e) => setDestino(e.target.value)}
                       placeholder="19 93501-0887"
                       className="w-52 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none
                                  placeholder:text-muted-foreground focus:border-primary/60" />
              </label>

              <label className="flex items-center gap-2 pb-2.5 text-sm">
                <input type="checkbox" checked={ativo} disabled={!atual.consentimento_ok}
                       onChange={(e) => setAtivo(e.target.checked)}
                       className="h-4 w-4 accent-primary disabled:opacity-40" />
                <span className={atual.consentimento_ok ? '' : 'text-muted-foreground'}>
                  Cobrar automaticamente
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Botao disabled={salvando}
                     onClick={() => rodar(async () => {
                       await api.salvarColeta(grupo, {
                         frequencia_coleta: freq, lembrete_ativo: ativo,
                         lembrete_destino: destino || null,
                       });
                       return 'Cobrança salva.';
                     })}>
                {salvando ? 'Salvando…' : 'Salvar'}
              </Botao>

              <button
                disabled={salvando || !destino}
                onClick={() => rodar(async () => {
                  const r = await api.enviarLembrete(grupo, destino || undefined);
                  return `Lembrete enviado para ${r.destino}.`;
                })}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2
                           font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground
                           transition hover:border-primary/50 hover:text-primary disabled:opacity-40">
                <Send className="h-3.5 w-3.5" /> Enviar agora
              </button>

              {atual.lembrete_enviado_em && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  último lembrete em {new Date(atual.lembrete_enviado_em).toLocaleString('pt-BR')}
                </span>
              )}
            </div>
          </div>
        )}
      </Card>

      {ehAdmin && <CanalDeAviso onMudou={carregar} />}
    </div>
  );
}

/**
 * Canal por onde o lembrete sai. É o Omnichannel Calliope, que a ERA já opera:
 * entrega hoje o que a Cloud API da Meta só entregaria depois de semanas de
 * verificação de negócio — e sem mexer no número comercial (D7).
 */
function CanalDeAviso({ onMudou }: { onMudou: () => void }) {
  const [conexoes, setConexoes] = useState<Conexao[] | null>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const [rotulo, setRotulo] = useState('WhatsApp comercial ERA');
  const [endpoint, setEndpoint] = useState('https://chat1.myuc2b.com:1443/api/v1/template/send');
  const [remetente, setRemetente] = useState('');
  const [template, setTemplate] = useState('lembrete_coleta');
  const [novoToken, setNovoToken] = useState('');

  const carregar = () =>
    api.conexoes().then((r) => {
      setConexoes(r.conexoes);
      const c = r.conexoes[0];
      if (c) {
        setRotulo(c.rotulo);
        setEndpoint(c.endpoint ?? '');
        setRemetente(c.remetente ?? '');
        setTemplate(c.config?.template ?? 'lembrete_coleta');
      }
    }).catch((e) => setErro((e as Error).message));

  useEffect(() => { carregar(); }, []);

  const rodar = async (fn: () => Promise<string>) => {
    setErro(''); setOk(''); setOcupado(true);
    try { setOk(await fn()); await carregar(); onMudou(); }
    catch (e) { setErro((e as Error).message); }
    finally { setOcupado(false); }
  };

  const atual = conexoes?.[0] ?? null;

  return (
    <Card>
      <Titulo sub="Por onde o painel envia a cobrança. Configurado aqui, não no servidor.">
        Canal de aviso
      </Titulo>

      {erro && <div className="mb-4"><Aviso tipo="erro">{erro}</Aviso></div>}
      {ok && <div className="mb-4"><Aviso tipo="ok">{ok}</Aviso></div>}

      {atual && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white/5 px-4 py-3 text-sm">
          <Plug className={'h-4 w-4 ' + (atual.status === 'conectado' ? 'text-primary' : 'text-muted-foreground')} />
          <span className="font-medium">
            {atual.status === 'conectado' ? 'Conectado'
              : atual.status === 'erro' ? 'Com erro' : 'Não testado'}
          </span>
          {atual.tem_token && <span className="text-xs text-muted-foreground">token cadastrado</span>}
          {atual.ultima_verificacao_em && (
            <span className="text-xs text-muted-foreground">
              testado em {new Date(atual.ultima_verificacao_em).toLocaleString('pt-BR')}
            </span>
          )}
          {atual.erro_mensagem && <span className="text-xs text-destructive">{atual.erro_mensagem}</span>}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">Nome do canal</span>
          <input value={rotulo} onChange={(e) => setRotulo(e.target.value)}
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">Endereço da API</span>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…"
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">Agente / attendance_id</span>
          <input value={remetente} onChange={(e) => setRemetente(e.target.value)} placeholder="opcional"
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">Template aprovado</span>
          <input value={template} onChange={(e) => setTemplate(e.target.value)}
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
            Token da API {atual?.tem_token && '(deixe vazio para manter o atual)'}
          </span>
          <input type="password" value={novoToken} onChange={(e) => setNovoToken(e.target.value)}
                 autoComplete="new-password"
                 placeholder={atual?.tem_token ? '••••••••' : 'cole o token do Calliope'}
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none
                            placeholder:text-muted-foreground focus:border-primary/60" />
        </label>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        O token é gravado cifrado (AES-256-GCM) e nunca é devolvido por nenhuma rota — nem para
        você, nem mascarado. Para trocá-lo, cole o novo; para conferir, use <b>Testar</b>.
        Pegue-o no Calliope em <b>Integrações → Token API</b>.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Botao disabled={ocupado}
               onClick={() => rodar(async () => {
                 await api.salvarConexao({
                   id: atual?.id, rotulo, endpoint,
                   remetente: remetente || undefined, template,
                   token: novoToken || undefined,
                 });
                 setNovoToken('');
                 return 'Canal salvo.';
               })}>
          {ocupado ? 'Salvando…' : 'Salvar canal'}
        </Botao>

        {atual && (
          <>
            <button disabled={ocupado || !atual.tem_token}
                    onClick={() => rodar(async () => {
                      await api.testarConexao(atual.id);
                      return 'O canal respondeu e o token foi aceito.';
                    })}
                    className="rounded-lg border border-border px-3 py-2 font-display text-xs font-semibold
                               uppercase tracking-wider text-muted-foreground transition
                               hover:border-primary/50 hover:text-primary disabled:opacity-40">
              Testar
            </button>
            <button disabled={ocupado || !atual.tem_token}
                    onClick={() => rodar(async () => {
                      await api.removerConexao(atual.id);
                      return 'Token removido. A cobrança automática para até você cadastrar outro.';
                    })}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2
                               font-display text-xs font-semibold uppercase tracking-wider
                               text-muted-foreground transition hover:border-destructive/50
                               hover:text-destructive disabled:opacity-40">
              <Trash2 className="h-3.5 w-3.5" /> Remover token
            </button>
          </>
        )}
      </div>
    </Card>
  );
}
