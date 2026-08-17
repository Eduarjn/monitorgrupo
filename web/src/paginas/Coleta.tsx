import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Flame, Link2, Loader2, MessageSquareWarning,
  Power, QrCode, RefreshCw, ShieldAlert, Smartphone, Unlink,
} from 'lucide-react';
import { api, type Alerta, type GrupoRemoto, type Instancia } from '../lib/api.ts';
import { Aviso, Botao, Card, Carregando, Titulo } from '../componentes/ui.tsx';

/**
 * Captura em tempo real (D8). O QR pareia o número uma vez; a partir daí as
 * mensagens dos grupos vinculados chegam por webhook e a IA analisa as janelas
 * quentes. O upload manual continua na aba Upload — é o backfill do passado,
 * porque o histórico via Baileys é instável.
 */

const ESTADOS: Record<Instancia['estado'], { rotulo: string; cor: string; dica: string }> = {
  conectado:     { rotulo: 'Conectado',    cor: 'text-primary',
                   dica: 'Recebendo mensagens dos grupos monitorados.' },
  qr_pendente:   { rotulo: 'Aguardando leitura', cor: 'text-aqua',
                   dica: 'Abra o WhatsApp no celular e leia o código abaixo.' },
  conectando:    { rotulo: 'Conectando',   cor: 'text-aqua',
                   dica: 'Pareou. Sincronizando com o WhatsApp…' },
  desconectado:  { rotulo: 'Desconectado', cor: 'text-muted-foreground',
                   dica: 'Nenhuma mensagem está sendo capturada.' },
  sessao_morta:  { rotulo: 'Sessão encerrada', cor: 'text-destructive',
                   dica: 'O aparelho desvinculou este dispositivo. É preciso parear de novo.' },
  erro:          { rotulo: 'Com erro',     cor: 'text-destructive',
                   dica: 'A Evolution respondeu com erro. Veja o motivo abaixo.' },
};

const quando = (s: string | null) =>
  s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function Coleta({ grupo, podeGerir, ehAdmin }: {
  grupo: number; podeGerir: boolean; ehAdmin: boolean;
}) {
  const [inst, setInst] = useState<Instancia | null>(null);
  const [configurada, setConfigurada] = useState(true);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');
  const [ocupado, setOcupado] = useState('');
  const timer = useRef<number | null>(null);

  const lerInstancia = useCallback(async () => {
    try {
      const r = await api.instancia();
      setInst(r.instancia);
      setConfigurada(r.configurada);
    } catch (e) { setErro((e as Error).message); }
    finally { setCarregando(false); }
  }, []);

  useEffect(() => { lerInstancia(); }, [lerInstancia]);

  // Enquanto o QR está na tela ele expira a cada ~20s e a Evolution manda outro.
  // Sem esse polling o usuário leria um código morto e nada aconteceria.
  useEffect(() => {
    const precisa = inst?.estado === 'qr_pendente' || inst?.estado === 'conectando';
    if (!precisa) { if (timer.current) window.clearInterval(timer.current); return; }
    timer.current = window.setInterval(lerInstancia, 3000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [inst?.estado, lerInstancia]);

  const rodar = async (nome: string, fn: () => Promise<string>) => {
    setErro(''); setOk(''); setOcupado(nome);
    try { setOk(await fn()); await lerInstancia(); }
    catch (e) { setErro((e as Error).message); }
    finally { setOcupado(''); }
  };

  if (carregando) return <Carregando texto="lendo o estado da conexão…" />;

  const e = inst ? ESTADOS[inst.estado] : ESTADOS.desconectado;

  return (
    <div className="space-y-6">
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {ok && <Aviso tipo="ok">{ok}</Aviso>}

      {!configurada && ehAdmin && (
        <Aviso tipo="erro">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              O servidor está sem <b>EVOLUTION_APIKEY</b> ou <b>CAPTURA_WEBHOOK_SEGREDO</b>.
              A captura não sobe sem os dois — eles ficam no arquivo de ambiente do serviço,
              não aqui, porque quem lê o painel não pode ler o segredo.
            </span>
          </div>
        </Aviso>
      )}

      {/* ---------------- estado da conexão ---------------- */}
      <Card>
        <Titulo sub="O número lê os grupos em tempo real. Pareamento é uma vez só.">
          Conexão do WhatsApp
        </Titulo>

        <div className="flex flex-wrap items-center gap-4">
          <span className={'flex items-center gap-2 font-display text-lg font-bold uppercase tracking-wide ' + e.cor}>
            {inst?.estado === 'conectado' ? <CheckCircle2 className="h-5 w-5" />
              : inst?.estado === 'qr_pendente' || inst?.estado === 'conectando'
                ? <Loader2 className="h-5 w-5 animate-spin" />
                : <Power className="h-5 w-5" />}
            {e.rotulo}
          </span>
          {inst?.numero_e164 && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Smartphone className="h-4 w-4" />{inst.numero_e164}
              {inst.perfil_nome && ` · ${inst.perfil_nome}`}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{e.dica}</p>
        {inst?.estado_motivo && inst.estado !== 'conectado' && (
          <p className="mt-1 text-xs text-destructive">Motivo informado: {inst.estado_motivo}</p>
        )}

        {inst?.estado === 'conectado' && (
          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div><span className="text-muted-foreground">Última mensagem</span>
              <div className="font-medium">{quando(inst.ultima_mensagem_em)}</div></div>
            <div><span className="text-muted-foreground">Último evento</span>
              <div className="font-medium">{quando(inst.ultimo_evento_em)}</div></div>
            <div><span className="text-muted-foreground">Reconexões</span>
              <div className="font-medium tabular-nums">{inst.reconexoes}</div></div>
          </div>
        )}

        {/* ---------------- QR ---------------- */}
        {inst?.qr_base64 && inst.estado === 'qr_pendente' && (
          <div className="mt-5 flex flex-col items-center gap-3 rounded-xl border border-border bg-white p-5">
            {/* fundo branco fixo: QR sobre superfície escura não é lido */}
            <img src={inst.qr_base64} alt="QR Code para parear o WhatsApp"
                 className="h-56 w-56" />
            <p className="text-center text-xs text-[#2C353D]">
              WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b>
              <br />O código muda sozinho a cada ~20 segundos.
            </p>
          </div>
        )}

        {ehAdmin && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {!inst?.pareada && (
              <Botao disabled={!!ocupado || !configurada}
                     onClick={() => rodar('criar', async () => {
                       await api.criarInstancia();
                       return 'Instância criada e webhook registrado.';
                     })}>
                {ocupado === 'criar' ? 'Preparando…' : 'Preparar captura'}
              </Botao>
            )}
            {inst?.pareada && inst.estado !== 'conectado' && (
              <Botao disabled={!!ocupado}
                     onClick={() => rodar('conectar', async () => {
                       const r = await api.conectar();
                       return r.qr ? 'Leia o código no celular.' : `Estado: ${r.estado}.`;
                     })}>
                <span className="inline-flex items-center gap-2">
                  <QrCode className="h-4 w-4" />
                  {ocupado === 'conectar' ? 'Gerando…' : 'Gerar QR Code'}
                </span>
              </Botao>
            )}
            {inst?.estado === 'conectado' && (
              <button disabled={!!ocupado}
                      onClick={() => rodar('sair', async () => {
                        await api.desconectarCaptura();
                        return 'Sessão encerrada. O período sem captura foi registrado como lacuna.';
                      })}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2
                                 font-display text-xs font-semibold uppercase tracking-wider
                                 text-muted-foreground transition hover:border-destructive/50
                                 hover:text-destructive disabled:opacity-40">
                <Unlink className="h-3.5 w-3.5" /> Desconectar
              </button>
            )}
            <button onClick={lerInstancia}
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
              <RefreshCw className="h-3.5 w-3.5" /> atualizar
            </button>
          </div>
        )}
      </Card>

      {ehAdmin && inst?.estado === 'conectado' && <GruposRemotos onMudou={lerInstancia} />}

      <FeedIA grupo={grupo} podeGerir={podeGerir} />

      <Aviso>
        <div className="flex gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-aqua" />
          <span>
            A captura só grava mensagens de <b>grupos vinculados e com consentimento registrado</b>.
            Conversa individual e grupo não vinculado são descartados antes de tocar o disco.
            O histórico anterior ao momento em que você ligou o monitoramento continua vindo do
            upload do <code>.txt</code>, na aba <b>Upload</b>.
          </span>
        </div>
      </Aviso>
    </div>
  );
}

/** Grupos do WhatsApp que o número participa, para ligar o monitoramento. */
function GruposRemotos({ onMudou }: { onMudou: () => void }) {
  const [grupos, setGrupos] = useState<GrupoRemoto[] | null>(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState('');

  const carregar = useCallback(() => {
    api.gruposRemotos().then((r) => setGrupos(r.grupos))
      .catch((e) => setErro((e as Error).message));
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const alternar = async (g: GrupoRemoto) => {
    setErro(''); setOcupado(g.jid);
    try {
      if (g.monitorado) await api.desvincularGrupo(g.grupo_id!);
      else await api.vincularGrupo(g.grupo_id!, g.jid, g.nome);
      carregar(); onMudou();
    } catch (e) { setErro((e as Error).message); }
    finally { setOcupado(''); }
  };

  /** Cria o grupo no painel. NÃO liga a captura — falta o consentimento. */
  const criar = async (g: GrupoRemoto) => {
    setErro(''); setOcupado(g.jid);
    try {
      await api.criarGrupoDoWhatsapp(g.jid, g.nome);
      carregar(); onMudou();
    } catch (e) { setErro((e as Error).message); }
    finally { setOcupado(''); }
  };

  return (
    <Card>
      <Titulo sub="Um clique por grupo. O monitoramento começa a valer a partir de agora — o passado vem do upload.">
        Grupos disponíveis
      </Titulo>
      {erro && <div className="mb-4"><Aviso tipo="erro">{erro}</Aviso></div>}
      {!grupos ? <Carregando texto="lendo os grupos do número…" />
        : grupos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            O número não participa de nenhum grupo. Entre nos grupos pelo celular — nunca pela API —
            e atualize aqui.
          </p>
        ) : (
          <div className="space-y-2">
            {grupos.map((g) => (
              <div key={g.jid}
                   className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{g.nome}</div>
                  <div className="text-xs text-muted-foreground">
                    {g.participantes != null && `${g.participantes} participantes · `}
                    {g.grupo_id ? `vinculado a "${g.nome_local}"` : 'sem grupo correspondente no painel'}
                  </div>
                </div>

                {g.monitorado && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/50
                                   bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                    <Link2 className="h-3 w-3" /> monitorado
                  </span>
                )}

                {!g.grupo_id ? (
                  // Antes isto era só um texto dizendo "crie o grupo no painel
                  // primeiro" — um beco sem saída, porque não havia onde criar.
                  <button disabled={ocupado === g.jid} onClick={() => criar(g)}
                          className="rounded-lg border border-border px-3 py-1.5 font-display text-xs
                                     font-semibold uppercase tracking-wider text-muted-foreground
                                     transition hover:border-primary/50 hover:text-primary
                                     disabled:opacity-40">
                    {ocupado === g.jid ? '…' : 'Criar no painel'}
                  </button>
                ) : !g.consentimento_ok && !g.monitorado ? (
                  <span className="text-right text-xs text-destructive">
                    registre o consentimento<br />
                    <span className="text-muted-foreground">aba Consentimento</span>
                  </span>
                ) : (
                  <button disabled={ocupado === g.jid} onClick={() => alternar(g)}
                          className={'rounded-lg border px-3 py-1.5 font-display text-xs font-semibold ' +
                            'uppercase tracking-wider transition disabled:opacity-40 ' +
                            (g.monitorado
                              ? 'border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive'
                              : 'border-primary bg-primary text-primary-foreground hover:brightness-110')}>
                    {ocupado === g.jid ? '…' : g.monitorado ? 'Desligar' : 'Ligar Monitoramento IA'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
    </Card>
  );
}

/** Feed estilo Gong: o que a IA extraiu das janelas quentes. */
function FeedIA({ grupo, podeGerir }: { grupo: number; podeGerir: boolean }) {
  const [alertas, setAlertas] = useState<Alerta[] | null>(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(() => {
    if (!grupo) { setAlertas([]); return; }
    api.alertas(grupo).then((r) => setAlertas(r.alertas))
      .catch((e) => setErro((e as Error).message));
  }, [grupo]);
  useEffect(() => { carregar(); }, [carregar]);

  const marcar = async (a: Alerta, estado: string) => {
    try { await api.marcarAlerta(grupo, a.id, estado); carregar(); }
    catch (e) { setErro((e as Error).message); }
  };

  const chama = (n: number) =>
    n >= 5 ? 'text-destructive' : n >= 3 ? 'text-[#FFAA44]' : 'text-muted-foreground';

  return (
    <Card>
      <Titulo sub="Menção, termo crítico ou pico de conversa disparam uma análise da janela — não de cada mensagem.">
        Inteligência do grupo
      </Titulo>
      {erro && <div className="mb-4"><Aviso tipo="erro">{erro}</Aviso></div>}

      {!alertas ? <Carregando /> : alertas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nada relevante ainda. O feed enche quando a conversa esquenta — silêncio aqui
          significa que não houve nada digno de alerta, e isso é resposta, não falha.
        </p>
      ) : (
        <div className="space-y-3">
          {alertas.map((a) => (
            <div key={a.id}
                 className={'rounded-lg border p-4 ' +
                   (a.estado === 'novo' ? 'border-border bg-white/5' : 'border-border opacity-60')}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Flame className={'h-4 w-4 ' + chama(a.severidade)} />
                <span className="font-display font-semibold uppercase tracking-wider">{a.tipo}</span>
                <span>· {new Date(a.criado_em).toLocaleString('pt-BR')}</span>
                {a.temperatura != null && <span>· temperatura {a.temperatura}/5</span>}
                {a.sentimento && <span>· {a.sentimento}</span>}
              </div>

              <div className="font-medium">{a.titulo}</div>
              {a.detalhe && <p className="mt-1 text-sm text-muted-foreground">{a.detalhe}</p>}
              {a.resumo && <p className="mt-2 whitespace-pre-wrap text-sm">{a.resumo}</p>}

              {a.dados?.pendencias?.length ? (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[2px] text-aqua">Pendências</div>
                  <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                    {a.dados.pendencias.map((p, i) => (
                      <li key={i}>{p.o_que}{p.de_quem && ` — ${p.de_quem}`}{p.prazo && ` (${p.prazo})`}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {a.dados?.dores?.length ? (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[2px] text-aqua">Dores</div>
                  <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                    {a.dados.dores.map((d, i) => (
                      <li key={i}><b>{d.tema}</b>{d.descricao && ` — ${d.descricao}`}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {a.dados?.proximo_passo && (
                <p className="mt-3 flex gap-2 rounded-lg bg-primary/10 p-3 text-sm">
                  <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>{a.dados.proximo_passo}</span>
                </p>
              )}

              {podeGerir && a.estado !== 'resolvido' && (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => marcar(a, 'resolvido')}
                          className="rounded-lg border border-border px-3 py-1 text-xs
                                     text-muted-foreground hover:border-primary/50 hover:text-primary">
                    marcar como resolvido
                  </button>
                  {a.estado === 'novo' && (
                    <button onClick={() => marcar(a, 'visto')}
                            className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground
                                       hover:text-foreground">
                      já vi
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
