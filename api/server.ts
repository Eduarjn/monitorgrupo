/**
 * whatsapp-monitor — camada HTTP.
 *
 * Serve a API que o painel na Vercel consome. Roda no servidor da ERA, atrás do
 * nginx em https://wa-api.sobreip.com.br — os dados sensíveis nunca saem daqui;
 * a Vercel serve apenas os arquivos estáticos do front.
 *
 * ⚠️ AUTORIZAÇÃO É RESPONSABILIDADE DESTE ARQUIVO.
 * Como o backend conecta com credencial de serviço, o RLS da Fase 1 é ignorado
 * (risco 1.6). Por isso toda rota que toca um grupo passa por `exigirAcesso()`,
 * que confere `grupo_acessos` explicitamente. Não confie no banco aqui.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import pg from 'pg';

import { autenticar, criarUsuario, emitirToken, garantirTabelaUsuarios, verificarToken,
         type UsuarioSessao } from './auth/auth.ts';
import { getHorariosDePico, getMencoesTermo, getRankingParticipantes,
         getVolumePorAutor, getVolumePorDia, type DB } from './stats/queries.ts';
import { criarProvider } from './ai/provider.ts';
import { indexarPeriodo } from './ai/embed.ts';
import { resumirDiaComCache } from './ai/summarize.ts';
import { perguntar } from './ai/search.ts';
import { parseTexto } from './ingestion/parser.ts';
import { hashArquivo } from './ingestion/dedup.ts';
import { abrir, sanitizar, selar } from './conexao/cripto.ts';
import { EvolutionDriver, segredoConfere } from './captura/evolution.ts';
import { ingerirCaptura } from './captura/ingest.ts';
import { analisarJanela, avaliarGatilho, gerarAlertas, montarJanela,
         REGRAS_PADRAO, type Regras } from './ai/analise.ts';
import { enviarTemplate, testarConexao, variaveisDoLembrete,
         type ConfigCalliope } from './conexao/calliope.ts';
import { getGruposParaLembrar, getSaudeColeta, normalizarDestino,
         proximaColeta, type FrequenciaColeta } from './coleta/queries.ts';

const PORTA = Number(process.env.PORTA ?? 3020);
const SEGREDO = process.env.JWT_SECRET ?? '';
const ORIGENS = (process.env.ORIGENS_PERMITIDAS ?? 'http://localhost:5173').split(',');

if (!SEGREDO) throw new Error('JWT_SECRET é obrigatório (use o mesmo segredo do PostgREST).');

const pool = new pg.Pool({ connectionString: process.env.PGURL, max: 8 });
const db: DB = { query: (t, p) => pool.query(t, p as never[]) };
const provider = criarProvider();

// ------------------------------------------------------- captura (D8)
const EVOLUTION_URL = process.env.EVOLUTION_URL ?? 'http://127.0.0.1:8080';
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY ?? '';
/** Segredo do header que a Evolution devolve em todo webhook. */
const CAPTURA_SEGREDO = process.env.CAPTURA_WEBHOOK_SEGREDO ?? '';
/** URL que a Evolution chama. Loopback: não passa por nginx nem pela internet. */
const CAPTURA_CALLBACK = process.env.CAPTURA_CALLBACK
  ?? `http://127.0.0.1:${process.env.PORTA ?? 3020}/captura/webhook`;
const INSTANCIA_NOME = process.env.CAPTURA_INSTANCIA ?? 'monitor-grupos';

const driver = new EvolutionDriver(EVOLUTION_URL, EVOLUTION_APIKEY);

// --------------------------------------------------------------- utilidades

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;

class ErroHttp extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

function cors(req: Req, res: Res) {
  const origem = req.headers.origin ?? '';
  // Lista branca explícita: `*` com credencial é justamente o que não queremos.
  if (ORIGENS.includes(origem)) res.setHeader('Access-Control-Allow-Origin', origem);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const responder = (res: Res, status: number, corpo: unknown) => {
  const txt = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(txt);
};

async function lerCorpo(req: Req, limiteMB = 64): Promise<Buffer> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const p of req) {
    total += p.length;
    // Export de grupo antigo é grande; o teto evita derrubar o processo com upload absurdo.
    if (total > limiteMB * 1024 * 1024) throw new ErroHttp(413, `Arquivo acima de ${limiteMB} MB.`);
    partes.push(p as Buffer);
  }
  return Buffer.concat(partes);
}

function usuarioDaRequisicao(req: Req): UsuarioSessao {
  const cabecalho = req.headers.authorization ?? '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : '';
  const u = token && verificarToken(token, SEGREDO);
  if (!u) throw new ErroHttp(401, 'Não autenticado.');
  return u;
}

/** A checagem que substitui o RLS nas rotas do backend. */
async function exigirAcesso(usuario: UsuarioSessao, grupoId: number, gerir = false) {
  const { rows } = await db.query<{ papel: string }>(
    `select papel from grupo_acessos where grupo_id = $1 and user_id = $2`,
    [grupoId, usuario.id],
  );
  const papel = rows[0]?.papel;
  if (!papel) throw new ErroHttp(403, 'Sem acesso a este grupo.');
  if (gerir && !['gestor', 'admin'].includes(papel)) throw new ErroHttp(403, 'Requer perfil de gestor.');
  return papel;
}

/**
 * Autorização de CONTA, não de grupo. O canal de aviso é um só para o painel
 * inteiro: sem isto, quem tem acesso de gestor a um grupo qualquer poderia
 * trocar o token do WhatsApp comercial da ERA.
 */
async function exigirAdmin(usuario: UsuarioSessao) {
  const { rows } = await db.query<{ papel_global: string }>(
    `select papel_global from usuarios where id = $1`, [usuario.id],
  );
  if (rows[0]?.papel_global !== 'admin') {
    throw new ErroHttp(403, 'Só um administrador do painel pode alterar o canal de aviso.');
  }
}

/**
 * Gate da LGPD (D7): coleta automática exige aviso registrado e não revogado.
 * Consulta a função do banco para que a regra viva num lugar só.
 */
async function consentimentoVigente(grupoId: number): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select consentimento_vigente($1) as ok`, [grupoId],
  );
  return rows[0]?.ok === true;
}

/**
 * Contadores de diagnóstico da captura.
 *
 * O filtro de LGPD descarta mensagem sem gravar nada — o que é correto, mas
 * deixa o pipeline cego: não havia como distinguir "as mensagens estão
 * chegando e sendo filtradas" de "não está chegando nada". Isso custou uma
 * rodada de diagnóstico às cegas no primeiro teste real.
 *
 * Só CONTAGEM: nenhum conteúdo, nenhum telefone, nada em disco. Zera no
 * restart, o que é suficiente — é instrumento de diagnóstico, não auditoria
 * (essa vive em wa_instancia_eventos).
 */
const diag = {
  desde: new Date().toISOString(),
  eventos: {} as Record<string, number>,
  mensagens: {} as Record<string, number>,
  ultimo_evento_em: null as string | null,
};
const contar = (balde: Record<string, number>, chave: string) => {
  balde[chave] = (balde[chave] ?? 0) + 1;
  diag.ultimo_evento_em = new Date().toISOString();
};

// ------------------------------------------------------- análise em tempo real

/**
 * Debounce por grupo. É o coração do controle de custo: uma discussão de 40
 * mensagens em 6 minutos vira UMA análise, não 40 — sem isso o custo é 40×
 * maior e o feed enche de alerta quase idêntico, que é como um painel desses
 * perde credibilidade e para de ser olhado.
 */
const pendentes = new Map<number, { timer: NodeJS.Timeout; gatilho: string; termo: string }>();

async function regrasDoGrupo(grupoId: number): Promise<Regras> {
  const { rows } = await db.query<Regras>(
    `select termos_criticos, mencoes, volume_limite, volume_janela_min, silencio_horas,
            debounce_seg, ia_ativa, teto_usd_dia::float8 as teto_usd_dia
       from wa_regras where grupo_id = $1`, [grupoId]);
  return rows[0] ?? REGRAS_PADRAO;
}

async function analisarSeGatilho(
  grupoId: number, _mensagemId: number, m: { conteudo: string; mencionados: string[] },
): Promise<void> {
  const regras = await regrasDoGrupo(grupoId);
  if (!regras.ia_ativa) return;

  const g = avaliarGatilho(m.conteudo, m.mencionados, regras);
  if (!g) return;

  const jaTem = pendentes.get(grupoId);
  if (jaTem) clearTimeout(jaTem.timer);   // reinicia a contagem a cada mensagem

  const timer = setTimeout(() => {
    pendentes.delete(grupoId);
    rodarAnalise(grupoId, g.gatilho, g.termo)
      .catch((e) => console.error('[analise]', (e as Error).message));
  }, Math.max(5, regras.debounce_seg) * 1000);
  timer.unref?.();
  pendentes.set(grupoId, { timer, gatilho: g.gatilho, termo: g.termo });
}

async function rodarAnalise(grupoId: number, gatilho: string, termo: string): Promise<void> {
  const { rows } = await db.query<{ nome: string }>(
    `select nome from grupos where id = $1`, [grupoId]);
  const msgs = await montarJanela(db, grupoId, new Date());
  if (msgs.length < 3) return;   // janela curta demais não rende análise

  const regras = await regrasDoGrupo(grupoId);
  const r = await analisarJanela(db, provider, grupoId, rows[0]?.nome ?? 'grupo',
                                 msgs, gatilho as never, termo, regras);
  if (!r.doCache) await gerarAlertas(db, grupoId, r.id, r.analise, gatilho as never);
}

/** Só as colunas seguras. O token cifrado nunca sai daqui — nem mascarado. */
const COLUNAS_CONEXAO = `id, rotulo, provedor, endpoint, remetente, config, status,
  erro_codigo, erro_mensagem, erro_em, ultima_verificacao_em, ultimo_uso_em,
  (token_cifrado is not null) as tem_token, criado_em, atualizado_em`;

async function conexaoAtiva(): Promise<{ id: number; cfg: ConfigCalliope } | null> {
  const { rows } = await db.query<{
    id: number; endpoint: string; remetente: string | null; config: Record<string, unknown>;
    token_cifrado: Buffer | null; token_iv: Buffer | null; token_tag: Buffer | null; token_versao: number;
  }>(`select id, endpoint, remetente, config, token_cifrado, token_iv, token_tag, token_versao
        from conexoes where status = 'conectado' and token_cifrado is not null
       order by atualizado_em desc limit 1`);
  const c = rows[0];
  if (!c?.token_cifrado || !c.token_iv || !c.token_tag || !c.endpoint) return null;
  return {
    id: c.id,
    cfg: {
      endpoint: c.endpoint,
      token: abrir({ cifrado: c.token_cifrado, iv: c.token_iv, tag: c.token_tag, versao: c.token_versao }),
      remetente: c.remetente ?? undefined,
      template: String(c.config?.template ?? 'lembrete_coleta'),
      idioma: String(c.config?.idioma ?? 'pt_BR'),
    },
  };
}

/** Dispara o lembrete de um grupo e registra o resultado. Nunca lança. */
async function dispararLembrete(
  grupo: { grupo_id: number; nome: string; destino: string; dias_sem_coleta: number | null },
): Promise<{ ok: boolean; erro?: string }> {
  const conexao = await conexaoAtiva();
  if (!conexao) return { ok: false, erro: 'Nenhum canal de aviso conectado.' };

  const r = await enviarTemplate(
    conexao.cfg, grupo.destino, variaveisDoLembrete(grupo.nome, grupo.dias_sem_coleta),
  );
  await db.query(
    `insert into lembretes_enviados (grupo_id, conexao_id, destino, status, erro, detalhe)
     values ($1,$2,$3,$4,$5,$6)`,
    [grupo.grupo_id, conexao.id, grupo.destino, r.ok ? 'enviado' : 'erro',
     r.erro ?? null, JSON.stringify(r.detalhe ?? {})],
  );
  if (r.ok) {
    await db.query(`update grupos set lembrete_enviado_em = now() where id = $1`, [grupo.grupo_id]);
    await db.query(`update conexoes set ultimo_uso_em = now() where id = $1`, [conexao.id]);
  }
  return { ok: r.ok, erro: r.erro };
}

const num = (v: string | null, padrao?: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    if (padrao !== undefined) return padrao;
    throw new ErroHttp(400, 'Parâmetro numérico inválido.');
  }
  return n;
};

// ------------------------------------------------------------------- rotas

async function rotear(req: Req, res: Res, url: URL): Promise<unknown> {
  const rota = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  if (rota === '/saude') return { ok: true, provider: provider.nome };

  // ---- autenticação -------------------------------------------------------
  if (rota === '/auth/login' && req.method === 'POST') {
    const { email, senha } = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    if (!email || !senha) throw new ErroHttp(400, 'Informe e-mail e senha.');
    const u = await autenticar(db, email, senha);
    if (!u) throw new ErroHttp(401, 'E-mail ou senha inválidos.');
    return { token: emitirToken(u, SEGREDO), usuario: u };
  }

  // ---- webhook da Evolution (D8) -----------------------------------------
  // PRECISA ficar acima da linha de autenticação: a Evolution não manda Bearer.
  // Defesa em camadas: (a) a rota não é exposta pelo nginx — a Evolution posta
  // direto em 127.0.0.1; (b) header secreto comparado em tempo constante.
  // A 2.3.7 não assina o corpo, então HMAC não está disponível.
  if (rota === '/captura/webhook' && req.method === 'POST') {
    if (!CAPTURA_SEGREDO) throw new ErroHttp(503, 'Captura não configurada.');
    // 401 e 422 ABORTAM o retry da Evolution. 500 seria retentado até 6x, e o
    // que não conseguimos processar agora não vai melhorar na sexta tentativa.
    if (!segredoConfere(req.headers['x-captura-segredo'] as string | undefined, CAPTURA_SEGREDO)) {
      throw new ErroHttp(401, 'Segredo inválido.');
    }
    let corpo: unknown;
    try {
      corpo = JSON.parse((await lerCorpo(req, 16)).toString() || '{}');
    } catch {
      throw new ErroHttp(422, 'Payload ilegível.');
    }

    // FILTRO LGPD, PRIMEIRO PASSO: `normalizarEvento` devolve null para tudo que
    // não é grupo. Conversa 1:1 do número monitorado morre aqui, em memória,
    // sem tocar o disco.
    const evento = driver.normalizarEvento(corpo);
    if (!evento) {
      // null aqui é quase sempre conversa 1:1 — o filtro funcionando. Contar
      // separa isso de "nada está chegando", que é outro problema.
      contar(diag.eventos, 'descartado_nao_grupo');
      return { ok: true, ignorado: 'fora_de_escopo' };
    }
    contar(diag.eventos, evento.tipo);

    if (evento.tipo === 'qr' && evento.qr) {
      await db.query(
        `update wa_instancias set estado = 'qr_pendente', qr_base64 = $1,
                qr_contagem = $2, qr_em = now(), ultimo_evento_em = now(), atualizado_em = now()
          where instancia_nome = $3`,
        [evento.qr.base64, evento.qr.contagem, INSTANCIA_NOME]);
      return { ok: true };
    }

    if (evento.tipo === 'conexao' && evento.conexao) {
      const c = evento.conexao;
      await db.query(
        `update wa_instancias
            set estado = $1, estado_motivo = $2, estado_em = now(),
                numero_e164 = coalesce($3, numero_e164),
                perfil_nome = coalesce($4, perfil_nome),
                qr_base64 = case when $1 = 'conectado' then null else qr_base64 end,
                reconexoes = reconexoes + case when $1 = 'conectado' then 1 else 0 end,
                ultimo_evento_em = now(), atualizado_em = now()
          where instancia_nome = $5`,
        [c.estado, c.motivo ?? null, c.numero_e164 ?? null, c.perfil_nome ?? null, INSTANCIA_NOME]);
      await db.query(
        `insert into wa_instancia_eventos (instancia_id, tipo, detalhe)
         select id, $2, $3 from wa_instancias where instancia_nome = $1`,
        [INSTANCIA_NOME, c.estado, JSON.stringify(sanitizar({ motivo: c.motivo }))]);
      return { ok: true };
    }

    if (evento.tipo === 'mensagem' && evento.mensagem) {
      // A ingestão é SÍNCRONA — são duas queries rápidas e idempotentes, e é o
      // que dá durabilidade sem precisar de log de webhook guardando texto de
      // terceiro. Os outros três portões de LGPD estão dentro dela.
      const r = await ingerirCaptura(db, evento.mensagem);
      contar(diag.mensagens, r.estado === 'descartada' ? `descartada:${r.motivo}` : r.estado);
      if (r.estado === 'gravada') {
        // A IA fica FORA do caminho crítico: uma chamada de modelo leva
        // segundos, e o socket da Evolution não pode esperar por ela.
        setImmediate(() => {
          analisarSeGatilho(r.grupo_id, r.mensagem_id, evento.mensagem!)
            .catch((e) => console.error('[analise]', (e as Error).message));
        });
      }
      return { ok: true, estado: r.estado };
    }

    return { ok: true };
  }

  const usuario = usuarioDaRequisicao(req);   // daqui para baixo, tudo autenticado

  if (rota === '/auth/eu') {
    // O papel vem do banco, não do token: revogar admin precisa valer na hora,
    // não só depois que o JWT de 12h vencer.
    const { rows } = await db.query<{ papel_global: string }>(
      `select papel_global from usuarios where id = $1`, [usuario.id]);
    return { usuario: { ...usuario, papel_global: rows[0]?.papel_global ?? 'usuario' } };
  }

  // ---- grupos -------------------------------------------------------------
  if (rota === '/grupos') {
    const { rows } = await db.query(
      // ::int — o driver devolve bigint como string; sem o cast, trocar de
      // grupo no seletor (que converte para número) não casa com nada.
      `select g.id::int as id, g.nome, g.descricao, g.frequencia_coleta, g.ultima_coleta_em, a.papel,
              (select count(*) from mensagens m where m.grupo_id = g.id)::int as mensagens
         from grupos g
         join grupo_acessos a on a.grupo_id = g.id and a.user_id = $1
        where g.ativo
        order by g.nome`,
      [usuario.id],
    );
    return { grupos: rows };
  }

  const grupoId = () => num(q.get('grupo_id'));
  const periodo = () => ({ inicio: q.get('inicio'), fim: q.get('fim') });

  // ---- estatísticas (Fase 3) ---------------------------------------------
  if (rota === '/stats/resumo') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const [autores, dias, pico] = await Promise.all([
      getVolumePorAutor(db, g, periodo()),
      getVolumePorDia(db, g, periodo()),
      getHorariosDePico(db, g, periodo()),
    ]);
    return {
      autores, dias, pico,
      total: autores.reduce((s, a) => s + a.mensagens, 0),
      ranking: autores.slice(0, 10),
    };
  }

  if (rota === '/stats/mencoes') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const termo = (q.get('termo') ?? '').trim();
    if (!termo) throw new ErroHttp(400, 'Informe o termo.');
    return await getMencoesTermo(db, g, termo, periodo());
  }

  if (rota === '/stats/ranking') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    return { ranking: await getRankingParticipantes(db, g, num(q.get('limite'), 10), periodo()) };
  }

  // ---- upload do export (Fase 2) -----------------------------------------
  if (rota === '/upload' && req.method === 'POST') {
    const g = grupoId(); await exigirAcesso(usuario, g, true);
    const nomeArquivo = q.get('nome') ?? 'export.txt';
    const conteudo = (await lerCorpo(req)).toString('utf8');
    if (!conteudo.trim()) throw new ErroHttp(400, 'Arquivo vazio.');

    const hash = hashArquivo(conteudo);
    const { rows: repetido } = await db.query<{ id: number; criado_em: string }>(
      `select id, criado_em from uploads where arquivo_hash = $1`, [hash],
    );
    // Dedup nível 1: mesmo ARQUIVO já processado. (O nível 2, por mensagem, é o
    // que resolve o export cumulativo — acontece no insert, mais abaixo.)
    if (repetido[0]) {
      return { duplicado: true, upload_id: repetido[0].id, enviado_em: repetido[0].criado_em,
               mensagens_novas: 0, mensagens_repetidas: 0 };
    }

    // O formato da data pode vir forçado pela tela quando o arquivo é ambíguo
    // (risco 1.1): todos os dias ≤ 12 impedem inferir DMY × MDY sozinho.
    const forcado = q.get('formato_data');
    const { mensagens, meta } = await parseTexto(conteudo, {
      formatoData: forcado === 'DMY' || forcado === 'MDY' ? forcado : undefined,
    });
    const ambigua = meta.formatoDataDetectado === 'ambiguo';

    const { rows: [up] } = await db.query<{ id: number }>(
      `insert into uploads (grupo_id, arquivo_nome, arquivo_hash, tamanho_bytes, plataforma,
                            formato_data, formato_confirmado, status, linhas_lidas, enviado_por)
       values ($1,$2,$3,$4,$5,$6,$7,'processando',$8,$9) returning id`,
      [g, nomeArquivo, hash, Buffer.byteLength(conteudo), meta.plataforma,
       meta.formatoDataUsado, !ambigua || !!forcado, meta.linhasLidas, usuario.id],
    );

    // O parser já devolve `hash_mensagem` (hash das partes CRUAS, imune a
    // mudança futura de interpretação de data). Aqui só aproveitamos.
    let novas = 0;
    for (const m of mensagens) {
      const { rowCount } = await db.query(
        `insert into mensagens (grupo_id, upload_id, autor_raw, enviada_em, conteudo, tipo,
                                midia_arquivo, hash_mensagem)
         values ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8)
         on conflict (grupo_id, hash_mensagem) do nothing`,
        [g, up.id, m.autor_raw, m.enviada_em, m.conteudo, m.tipo, m.midia_arquivo, m.hash_mensagem],
      );
      novas += rowCount ?? 0;
    }
    const repetidas = mensagens.length - novas;

    await db.query(
      `update uploads set status='concluido', mensagens_novas=$2, mensagens_repetidas=$3,
                          processado_em=now() where id=$1`,
      [up.id, novas, repetidas],
    );
    // Reagenda a próxima coleta a partir de AGORA. Antes desta fase nada nunca
    // escrevia em `proxima_coleta_em`, então nenhum grupo ficava "atrasado" e o
    // painel de saúde não tinha régua.
    const { rows: [freq] } = await db.query<{ frequencia_coleta: FrequenciaColeta }>(
      `update grupos set ultima_coleta_em = now() where id = $1 returning frequencia_coleta`, [g]);
    const prox = proximaColeta(freq?.frequencia_coleta ?? 'semanal', new Date());
    await db.query(`update grupos set proxima_coleta_em = $2 where id = $1`,
                   [g, prox?.toISOString() ?? null]);

    return {
      duplicado: false, upload_id: up.id,
      plataforma: meta.plataforma,
      formato_data: meta.formatoDataUsado,
      data_ambigua: ambigua,
      avisos: meta.avisos,
      por_tipo: meta.porTipo,
      linhas_lidas: meta.linhasLidas,
      mensagens_lidas: mensagens.length,
      mensagens_novas: novas, mensagens_repetidas: repetidas,
      proxima_coleta_em: prox?.toISOString() ?? null,
      // Upload é ato humano e deliberado: avisa, não bloqueia. O bloqueio vale
      // para o que roda sozinho (lembrete automático). Ver D7.
      sem_consentimento: !(await consentimentoVigente(g)),
    };
  }

  if (rota === '/uploads') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const { rows } = await db.query(
      `select id, arquivo_nome, plataforma, formato_data, status, linhas_lidas,
              mensagens_novas, mensagens_repetidas, criado_em
         from uploads where grupo_id=$1 order by criado_em desc limit 20`, [g]);
    return { uploads: rows };
  }

  // ---- IA (Fase 5) --------------------------------------------------------
  if (rota === '/resumo') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const dia = q.get('dia');
    if (!dia || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new ErroHttp(400, 'Informe dia=YYYY-MM-DD.');
    return await resumirDiaComCache(db, provider, g, dia);
  }

  if (rota === '/busca' && req.method === 'POST') {
    const { grupo_id, pergunta } = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(grupo_id));
    await exigirAcesso(usuario, g);
    if (!pergunta?.trim()) throw new ErroHttp(400, 'Informe a pergunta.');

    // "Não encontrei isso no histórico" é tecnicamente correto quando o grupo
    // nunca foi indexado — e completamente inútil, porque parece falha da IA
    // quando é falta de um clique. Distinguir os dois casos custa uma query.
    const { rows: [n] } = await db.query<{ mensagens: number; blocos: number }>(
      `select (select count(*) from mensagens where grupo_id = $1)::int as mensagens,
              (select count(*) from blocos    where grupo_id = $1)::int as blocos`, [g]);
    if (n && n.blocos === 0) {
      return {
        pergunta,
        resposta: n.mensagens === 0
          ? 'Este grupo ainda não tem nenhuma mensagem. Ligue a captura na aba Coleta ou envie um export na aba Upload.'
          : `Este grupo tem ${n.mensagens} mensagens, mas nenhuma foi indexada ainda. ` +
            'Clique em "Reindexar histórico" logo abaixo — é o que cria os vetores que a busca usa.',
        fontes: [],
        precisa_indexar: n.mensagens > 0,
      };
    }
    return await perguntar(db, provider, g, pergunta, { topK: 8, minSimilaridade: 0.05 });
  }

  if (rota === '/indexar' && req.method === 'POST') {
    const g = grupoId(); await exigirAcesso(usuario, g, true);
    const { rows: [lim] } = await db.query<{ ini: string; fim: string }>(
      `select min(enviada_em)::text ini, (max(enviada_em) + interval '1 day')::text fim
         from mensagens where grupo_id=$1`, [g]);
    if (!lim?.ini) return { blocos: 0, tokens: 0, usd: 0 };
    // Reindexação é TOTAL: apaga todos os blocos do grupo antes de recriar.
    // O delete por janela de `indexarPeriodo` não alcança bloco cujo inicio_em
    // ficou fora do intervalo — foi assim que sobrou um bloco com horário
    // errado depois da correção de fuso.
    await db.query(`delete from blocos where grupo_id = $1`, [g]);
    return await indexarPeriodo(db, provider, g, { inicio: lim.ini, fim: lim.fim });
  }

  // ---- consentimento (Fase 1 / LGPD) -------------------------------------
  if (rota === '/consentimentos' && req.method === 'GET') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const { rows } = await db.query(
      `select c.id, c.versao_texto, c.texto, c.base_legal, c.canal, c.consentido_em,
              c.revogado_em, p.nome_exibicao as pessoa
         from consentimentos c left join pessoas p on p.id = c.pessoa_id
        where c.grupo_id = $1 order by c.consentido_em desc`, [g]);
    return { consentimentos: rows };
  }

  if (rota === '/consentimentos' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g, true);
    if (!corpo.texto?.trim()) throw new ErroHttp(400, 'Informe o texto do aviso.');
    const { rows } = await db.query(
      `insert into consentimentos (grupo_id, versao_texto, texto, base_legal, canal, registrado_por)
       values ($1,$2,$3,$4,$5,$6) returning id, consentido_em`,
      [g, corpo.versao_texto ?? 'v1', corpo.texto, corpo.base_legal ?? 'consentimento',
       corpo.canal ?? null, usuario.id],
    );
    return { consentimento: rows[0] };
  }

  if (rota === '/consentimentos/revogar' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g, true);
    const id = num(String(corpo.id));
    // Revogação é por registro, não por grupo: o aviso continua no histórico
    // com a data em que deixou de valer — apagar seria destruir a prova.
    const { rows } = await db.query(
      `update consentimentos set revogado_em = now()
        where id = $1 and grupo_id = $2 and revogado_em is null
        returning id, revogado_em`, [id, g]);
    if (!rows[0]) throw new ErroHttp(404, 'Aviso não encontrado ou já revogado.');
    return { consentimento: rows[0], consentimento_vigente: await consentimentoVigente(g) };
  }

  // ---- coleta assistida (Opção A / D7) -----------------------------------
  if (rota === '/coleta/saude') {
    return { grupos: await getSaudeColeta(db, usuario.id) };
  }

  if (rota === '/coleta/config' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g, true);

    const freq = String(corpo.frequencia_coleta ?? 'semanal') as FrequenciaColeta;
    if (!['diaria', 'semanal', 'manual'].includes(freq)) {
      throw new ErroHttp(400, 'Frequência inválida.');
    }
    const ativo = corpo.lembrete_ativo === true;

    let destino: string | null = null;
    if (corpo.lembrete_destino) {
      destino = normalizarDestino(String(corpo.lembrete_destino));
      if (!destino) throw new ErroHttp(400, 'Telefone inválido. Use DDD + número, ex.: 19 93501-0887.');
    }
    // Ligar a cobrança sem destino deixaria a rotina silenciosamente inerte.
    if (ativo && !destino) throw new ErroHttp(400, 'Informe o telefone que vai receber o lembrete.');
    // Gate da LGPD: automatizar aviso exige consentimento registrado (D7).
    if (ativo && !(await consentimentoVigente(g))) {
      throw new ErroHttp(409, 'Registre o aviso de consentimento deste grupo antes de ligar o lembrete.');
    }

    // A régua de atraso só existe depois que há uma base de cálculo.
    const { rows } = await db.query(
      `update grupos
          set frequencia_coleta = $2,
              lembrete_ativo    = $3,
              lembrete_destino  = $4,
              proxima_coleta_em = case
                when $2 = 'manual' then null
                when ultima_coleta_em is not null
                  then ultima_coleta_em + ($5 || ' days')::interval
                else now() + ($5 || ' days')::interval
              end
        where id = $1
      returning id, frequencia_coleta, lembrete_ativo, lembrete_destino,
                ultima_coleta_em, proxima_coleta_em`,
      [g, freq, ativo, destino, freq === 'diaria' ? 1 : 7],
    );
    return { grupo: rows[0] };
  }

  if (rota === '/coleta/lembrete' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g, true);
    if (!(await consentimentoVigente(g))) {
      throw new ErroHttp(409, 'Registre o aviso de consentimento antes de enviar o lembrete.');
    }
    const { rows } = await db.query<{ nome: string; destino: string | null; dias: number | null }>(
      `select nome, lembrete_destino as destino,
              case when ultima_coleta_em is null then null
                   else floor(extract(epoch from (now() - ultima_coleta_em)) / 86400)::int
              end as dias
         from grupos where id = $1`, [g]);
    const alvo = corpo.destino ? normalizarDestino(String(corpo.destino)) : rows[0]?.destino;
    if (!alvo) throw new ErroHttp(400, 'Informe o telefone que vai receber o lembrete.');

    const r = await dispararLembrete({
      grupo_id: g, nome: rows[0]?.nome ?? 'grupo', destino: alvo, dias_sem_coleta: rows[0]?.dias ?? null,
    });
    if (!r.ok) throw new ErroHttp(502, r.erro ?? 'Não foi possível enviar o lembrete.');
    return { enviado: true, destino: alvo };
  }

  if (rota === '/coleta/lembretes') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const { rows } = await db.query(
      `select id, destino, status, erro, criado_em from lembretes_enviados
        where grupo_id = $1 order by criado_em desc limit 20`, [g]);
    return { lembretes: rows };
  }

  /**
   * Rodada da cobrança. Chamada pelo systemd timer do servidor, autenticada
   * como qualquer outra rota — não é endpoint público.
   */
  if (rota === '/coleta/executar' && req.method === 'POST') {
    await exigirAdmin(usuario);
    const pendentes = await getGruposParaLembrar(db);
    const resultados = [];
    for (const g of pendentes) {
      const r = await dispararLembrete(g);
      resultados.push({ grupo: g.nome, ok: r.ok, erro: r.erro });
    }
    return { avaliados: pendentes.length, resultados };
  }

  // ---- canal de aviso (configurado pela interface) ------------------------
  if (rota === '/conexoes' && req.method === 'GET') {
    await exigirAdmin(usuario);
    const { rows } = await db.query(
      `select ${COLUNAS_CONEXAO} from conexoes order by atualizado_em desc`);
    return { conexoes: rows };
  }

  if (rota === '/conexoes' && req.method === 'POST') {
    await exigirAdmin(usuario);
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const endpoint = String(corpo.endpoint ?? '').trim();
    if (!/^https:\/\//i.test(endpoint)) {
      throw new ErroHttp(400, 'O endereço da API precisa começar com https://');
    }
    const config = {
      template: String(corpo.template ?? 'lembrete_coleta').trim(),
      idioma: String(corpo.idioma ?? 'pt_BR').trim(),
    };
    const id = corpo.id ? num(String(corpo.id)) : null;

    // Token só é gravado quando vem preenchido: reeditar o canal não pode
    // apagar o segredo por descuido de quem deixou o campo em branco.
    let selado = null;
    if (corpo.token) {
      try {
        selado = selar(String(corpo.token));
      } catch (e) {
        // Chave de cifra ausente é erro de instalação, não do usuário — mas o
        // 500 genérico esconderia justamente a informação que resolve.
        throw new ErroHttp(503, 'O servidor está sem a chave de criptografia (CONEXAO_CHAVE_V1). ' +
                                'O token não foi gravado.');
      }
    }

    if (id) {
      const { rows } = await db.query(
        `update conexoes set rotulo=$2, endpoint=$3, remetente=$4, config=$5,
                atualizado_em=now(),
                token_cifrado = coalesce($6, token_cifrado),
                token_iv      = coalesce($7, token_iv),
                token_tag     = coalesce($8, token_tag),
                token_versao  = coalesce($9, token_versao)
          where id=$1 returning ${COLUNAS_CONEXAO}`,
        [id, String(corpo.rotulo ?? 'Canal de aviso'), endpoint, corpo.remetente ?? null,
         JSON.stringify(config), selado?.cifrado ?? null, selado?.iv ?? null,
         selado?.tag ?? null, selado?.versao ?? null]);
      if (!rows[0]) throw new ErroHttp(404, 'Canal não encontrado.');
      await db.query(
        `insert into conexao_eventos (conexao_id, tipo, detalhe) values ($1,$2,$3)`,
        [id, selado ? 'token_trocado' : 'editada', JSON.stringify(sanitizar(config))]);
      return { conexao: rows[0] };
    }

    if (!selado) throw new ErroHttp(400, 'Informe o token da API do Calliope.');
    const { rows } = await db.query(
      `insert into conexoes (rotulo, provedor, endpoint, remetente, config,
                             token_cifrado, token_iv, token_tag, token_versao, criado_por)
       values ($1,'calliope',$2,$3,$4,$5,$6,$7,$8,$9) returning ${COLUNAS_CONEXAO}`,
      [String(corpo.rotulo ?? 'Canal de aviso'), endpoint, corpo.remetente ?? null,
       JSON.stringify(config), selado.cifrado, selado.iv, selado.tag, selado.versao, usuario.id]);
    await db.query(
      `insert into conexao_eventos (conexao_id, tipo, detalhe) values ($1,'criada',$2)`,
      [rows[0].id, JSON.stringify(sanitizar(config))]);
    return { conexao: rows[0] };
  }

  if (rota === '/conexoes/testar' && req.method === 'POST') {
    await exigirAdmin(usuario);
    const id = num(q.get('id'));
    const { rows } = await db.query<{
      endpoint: string | null; remetente: string | null; config: Record<string, unknown>;
      token_cifrado: Buffer | null; token_iv: Buffer | null; token_tag: Buffer | null; token_versao: number;
    }>(`select endpoint, remetente, config, token_cifrado, token_iv, token_tag, token_versao
          from conexoes where id = $1`, [id]);
    const c = rows[0];
    if (!c) throw new ErroHttp(404, 'Canal não encontrado.');
    if (!c.token_cifrado || !c.token_iv || !c.token_tag || !c.endpoint) {
      throw new ErroHttp(400, 'Cadastre o endereço e o token antes de testar.');
    }

    const r = await testarConexao({
      endpoint: c.endpoint,
      token: abrir({ cifrado: c.token_cifrado, iv: c.token_iv, tag: c.token_tag, versao: c.token_versao }),
      remetente: c.remetente ?? undefined,
      template: String(c.config?.template ?? 'lembrete_coleta'),
    });

    await db.query(
      `update conexoes set status=$2, ultima_verificacao_em=now(),
              erro_mensagem=$3, erro_em = case when $2='erro' then now() else null end,
              atualizado_em=now()
        where id=$1`,
      [id, r.ok ? 'conectado' : 'erro', r.erro ?? null]);
    await db.query(
      `insert into conexao_eventos (conexao_id, tipo, detalhe) values ($1,'testada',$2)`,
      [id, JSON.stringify(sanitizar({ ok: r.ok, status: r.status }))]);

    if (!r.ok) throw new ErroHttp(502, r.erro ?? 'O canal não respondeu.');
    return { ok: true, status: 'conectado' };
  }

  if (rota === '/conexoes/remover' && req.method === 'POST') {
    await exigirAdmin(usuario);
    const id = num(q.get('id'));
    // Zera o segredo em vez de apagar a linha: o histórico de eventos continua
    // valendo como auditoria de quem ligou o quê, e quando.
    const { rows } = await db.query(
      `update conexoes set token_cifrado=null, token_iv=null, token_tag=null,
              status='desconectado', atualizado_em=now()
        where id=$1 returning ${COLUNAS_CONEXAO}`, [id]);
    if (!rows[0]) throw new ErroHttp(404, 'Canal não encontrado.');
    await db.query(
      `insert into conexao_eventos (conexao_id, tipo, detalhe) values ($1,'removida','{}')`, [id]);
    return { conexao: rows[0] };
  }

  // ---- captura: instância e pareamento (D8) -------------------------------
  const COLUNAS_INSTANCIA = `id::int as id, rotulo, instancia_nome, numero_e164, perfil_nome,
    estado, estado_motivo, estado_em, qr_base64, qr_contagem, qr_em,
    ultimo_evento_em, ultima_mensagem_em, reconexoes,
    (token_cifrado is not null) as pareada, criado_em, atualizado_em`;

  /**
   * Diagnóstico do pipeline: o que chegou e o que foi filtrado, por motivo.
   * Responde a pergunta "está chegando mensagem?" sem precisar de log da
   * Evolution (que roda em LOG_LEVEL=ERROR e não registra webhook).
   */
  if (rota === '/captura/diagnostico') {
    await exigirAdmin(usuario);
    return {
      contadores: diag,
      dica: Object.keys(diag.eventos).length === 0
        ? 'Nenhum evento recebido desde o último restart. Confira se a instância está conectada e se o webhook aponta para a nossa API.'
        : (diag.mensagens['descartada:grupo_nao_vinculado'] ?? 0) > 0
          ? 'Mensagens estão chegando e sendo descartadas: os grupos ainda não foram vinculados na aba Coleta.'
          : (diag.mensagens['descartada:sem_consentimento'] ?? 0) > 0
            ? 'Grupo vinculado, mas sem aviso de consentimento vigente — registre na aba Consentimento.'
            : 'Pipeline recebendo normalmente.',
    };
  }

  if (rota === '/captura/instancia' && req.method === 'GET') {
    await exigirAdmin(usuario);
    const { rows } = await db.query(
      `select ${COLUNAS_INSTANCIA} from wa_instancias where instancia_nome = $1`, [INSTANCIA_NOME]);
    return { instancia: rows[0] ?? null, configurada: !!EVOLUTION_APIKEY && !!CAPTURA_SEGREDO };
  }

  /** Cria a instância na Evolution e registra o webhook. Idempotente na prática. */
  if (rota === '/captura/instancia' && req.method === 'POST') {
    await exigirAdmin(usuario);
    if (!EVOLUTION_APIKEY || !CAPTURA_SEGREDO) {
      throw new ErroHttp(503, 'O servidor está sem EVOLUTION_APIKEY ou CAPTURA_WEBHOOK_SEGREDO.');
    }
    let token = '', uuid: string | null = null;
    try {
      const r = await driver.criarInstancia(INSTANCIA_NOME);
      token = r.token; uuid = r.uuid;
    } catch (e) {
      // Já existir não é erro: seguimos para (re)registrar o webhook.
      if (!/already in use|already exists/i.test((e as Error).message)) throw e;
    }
    await driver.registrarWebhook(INSTANCIA_NOME, CAPTURA_CALLBACK, CAPTURA_SEGREDO);

    const selado = token ? selar(token) : null;
    const { rows } = await db.query(
      `insert into wa_instancias (rotulo, endpoint, instancia_nome, instancia_uuid,
                                  token_cifrado, token_iv, token_tag, token_versao, criado_por)
       values ('Captura de grupos', $1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (instancia_nome) do update
         set instancia_uuid = coalesce(excluded.instancia_uuid, wa_instancias.instancia_uuid),
             token_cifrado  = coalesce(excluded.token_cifrado, wa_instancias.token_cifrado),
             token_iv       = coalesce(excluded.token_iv, wa_instancias.token_iv),
             token_tag      = coalesce(excluded.token_tag, wa_instancias.token_tag),
             atualizado_em  = now()
       returning ${COLUNAS_INSTANCIA}`,
      [EVOLUTION_URL, INSTANCIA_NOME, uuid, selado?.cifrado ?? null, selado?.iv ?? null,
       selado?.tag ?? null, selado?.versao ?? 1, usuario.id]);
    return { instancia: rows[0] };
  }

  if (rota === '/captura/conectar' && req.method === 'POST') {
    await exigirAdmin(usuario);
    const r = await driver.conectar(INSTANCIA_NOME);
    if ('base64' in r) {
      await db.query(
        `update wa_instancias set estado='qr_pendente', qr_base64=$1, qr_contagem=$2,
                qr_em=now(), atualizado_em=now() where instancia_nome=$3`,
        [r.base64, r.contagem, INSTANCIA_NOME]);
      return { qr: r.base64, contagem: r.contagem, estado: 'qr_pendente' };
    }
    await db.query(`update wa_instancias set estado=$1, estado_em=now() where instancia_nome=$2`,
                   [r.estado, INSTANCIA_NOME]);
    return { qr: null, estado: r.estado };
  }

  if (rota === '/captura/desconectar' && req.method === 'POST') {
    await exigirAdmin(usuario);
    await driver.desconectar(INSTANCIA_NOME).catch(() => {});
    await db.query(
      `update wa_instancias set estado='desconectado', qr_base64=null, estado_em=now(),
              atualizado_em=now() where instancia_nome=$1`, [INSTANCIA_NOME]);
    // Sessão caída = buraco no histórico. Registrar é o que permite dizer ao
    // usuário qual período precisa ser coberto por upload.
    await db.query(
      `insert into wa_lacunas (instancia_id, inicio_em, motivo)
       select id, now(), 'desconexao_manual' from wa_instancias where instancia_nome=$1`,
      [INSTANCIA_NOME]);
    return { estado: 'desconectado' };
  }

  /** Grupos do WhatsApp que o número participa — para escolher o que monitorar. */
  if (rota === '/captura/grupos') {
    await exigirAdmin(usuario);
    const remotos = await driver.listarGrupos(INSTANCIA_NOME);
    const { rows: locais } = await db.query<{ id: number; nome: string; wa_jid: string | null;
                                              captura_ativa: boolean; consentimento_ok: boolean }>(
      `select g.id::int as id, g.nome, g.wa_jid, g.captura_ativa,
              consentimento_vigente(g.id) as consentimento_ok
         from grupos g join grupo_acessos a on a.grupo_id = g.id and a.user_id = $1
        where g.ativo`, [usuario.id]);
    return {
      grupos: remotos.map((r) => {
        const local = locais.find((l) => l.wa_jid === r.jid) ?? null;
        return { ...r, grupo_id: local?.id ?? null, nome_local: local?.nome ?? null,
                 monitorado: local?.captura_ativa ?? false,
                 consentimento_ok: local?.consentimento_ok ?? false };
      }),
      locais_sem_vinculo: locais.filter((l) => !l.wa_jid),
    };
  }

  /**
   * Cria o grupo local a partir de um grupo do WhatsApp.
   *
   * Sem isto a tela ficava num beco: listava os grupos remotos e dizia "crie o
   * grupo no painel primeiro", sem oferecer como. Criar aqui NÃO liga a captura
   * — só passa a existir no painel, para então registrar o consentimento e só
   * depois vincular. A ordem importa: é ela que mantém o gate da LGPD honesto.
   */
  if (rota === '/captura/criar-grupo' && req.method === 'POST') {
    await exigirAdmin(usuario);
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const jid = String(corpo.wa_jid ?? '').trim();
    const nome = String(corpo.nome ?? '').trim();
    if (!jid.endsWith('@g.us')) throw new ErroHttp(400, 'Identificador de grupo inválido.');
    if (!nome) throw new ErroHttp(400, 'Informe o nome do grupo.');

    const { rows: existe } = await db.query<{ id: number; nome: string }>(
      `select id::int as id, nome from grupos where wa_jid = $1`, [jid]);
    if (existe[0]) throw new ErroHttp(409, `Este grupo já existe no painel como "${existe[0].nome}".`);

    const { rows } = await db.query<{ id: number; nome: string }>(
      `insert into grupos (nome, wa_jid, wa_nome_remoto, criado_por)
       values ($1, $2, $1, $3) returning id::int as id, nome`,
      [nome.slice(0, 120), jid, usuario.id]);

    // Quem cria vira admin do grupo: sem uma linha em grupo_acessos, nem quem
    // acabou de criar conseguiria abrir o painel dele (exigirAcesso barra).
    await db.query(
      `insert into grupo_acessos (grupo_id, user_id, papel) values ($1, $2, 'admin')
       on conflict do nothing`, [rows[0].id, usuario.id]);

    return { grupo: rows[0] };
  }

  /** "Ligar Monitoramento IA" — um botão só, com o gate de LGPD atrás dele. */
  if (rota === '/captura/vincular' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g, true);
    const jid = String(corpo.wa_jid ?? '').trim();
    if (!jid.endsWith('@g.us')) throw new ErroHttp(400, 'Identificador de grupo inválido.');

    // O gate que não se reverte: captura contínua roda sozinha 24h, sem uma
    // pessoa decidindo por mensagem. Por isso bloqueia, não avisa (D7/D8).
    //
    // `confirmar_aviso` permite registrar o consentimento aqui, no mesmo clique
    // — mas só como AFIRMAÇÃO EXPLÍCITA de quem tem papel de gestão: "eu avisei
    // o grupo". O registro guarda o texto, a versão e quem afirmou, que é
    // exatamente o que o consentimento precisa provar. Sem isso o usuário
    // precisava trocar o seletor do cabeçalho e ir a outra aba, e no primeiro
    // uso real quatro avisos acabaram gravados no grupo errado.
    if (!(await consentimentoVigente(g))) {
      if (corpo.confirmar_aviso !== true) {
        throw new ErroHttp(409, 'Registre o aviso de consentimento deste grupo antes de ligar o monitoramento.');
      }
      const texto = String(corpo.texto ?? '').trim();
      if (texto.length < 30) throw new ErroHttp(400, 'O texto do aviso é obrigatório.');
      await db.query(
        `insert into consentimentos (grupo_id, versao_texto, texto, base_legal, canal, registrado_por)
         values ($1, $2, $3, 'consentimento', $4, $5)`,
        [g, String(corpo.versao_texto ?? 'v1'), texto,
         String(corpo.canal ?? 'mensagem no grupo'), usuario.id]);
    }
    const { rows } = await db.query(
      `update grupos set wa_jid = $2, wa_nome_remoto = $3, captura_ativa = true,
              captura_inicio_em = coalesce(captura_inicio_em, now())
        where id = $1
      returning id::int as id, nome, wa_jid, captura_ativa, captura_inicio_em`,
      [g, jid, corpo.wa_nome ?? null]);
    await db.query(
      `insert into wa_regras (grupo_id) values ($1) on conflict (grupo_id) do nothing`, [g]);
    return { grupo: rows[0] };
  }

  if (rota === '/captura/desvincular' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g, true);
    const { rows } = await db.query(
      `update grupos set captura_ativa = false where id = $1
       returning id::int as id, nome, captura_ativa`, [g]);
    return { grupo: rows[0] };
  }

  // ---- feed de inteligência ----------------------------------------------
  if (rota === '/alertas') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const { rows } = await db.query(
      `select a.id::int as id, a.tipo, a.severidade, a.titulo, a.detalhe, a.estado,
              a.criado_em, an.resumo, an.temperatura, an.sentimento, an.dados
         from wa_alertas a left join wa_analises an on an.id = a.analise_id
        where a.grupo_id = $1
        order by a.criado_em desc limit 50`, [g]);
    return { alertas: rows };
  }

  if (rota === '/alertas/estado' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 1)).toString() || '{}');
    const g = num(String(corpo.grupo_id));
    await exigirAcesso(usuario, g);
    const estado = String(corpo.estado ?? 'visto');
    if (!['novo', 'visto', 'resolvido'].includes(estado)) throw new ErroHttp(400, 'Estado inválido.');
    const { rows } = await db.query(
      `update wa_alertas set estado = $3, visto_em = now()
        where id = $1 and grupo_id = $2 returning id::int as id, estado`,
      [num(String(corpo.id)), g, estado]);
    if (!rows[0]) throw new ErroHttp(404, 'Alerta não encontrado.');
    return { alerta: rows[0] };
  }

  if (rota === '/analise/uso') {
    const g = grupoId(); await exigirAcesso(usuario, g);
    const { rows } = await db.query(
      `select dia, chamadas, usd::float8 as usd from wa_uso_ia
        where grupo_id = $1 and dia > current_date - 30 order by dia desc`, [g]);
    return { uso: rows, teto: (await regrasDoGrupo(g)).teto_usd_dia };
  }

  throw new ErroHttp(404, 'Rota não encontrada.');
}

// ------------------------------------------------------------------ servidor

const servidor = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    responder(res, 200, await rotear(req, res, url));
  } catch (e) {
    const erro = e as ErroHttp;
    const status = erro.status ?? 500;
    if (status >= 500) console.error(`[erro] ${url.pathname}:`, erro);
    // Mensagem genérica só para exceção INESPERADA — aí o detalhe interno não
    // pode vazar. Quando nós mesmos definimos o status (ErroHttp/ErroEvolution),
    // a mensagem foi escrita para o usuário ler e precisa chegar inteira: um
    // 503 "a Evolution não está no ar" virando "Erro interno." só transforma um
    // diagnóstico de dois segundos numa caça ao log.
    const nosso = typeof erro?.status === 'number';
    responder(res, status, { erro: nosso || status < 500 ? erro.message : 'Erro interno.' });
  }
});

/**
 * Rotina de cobrança da coleta (D3/D7).
 *
 * Roda DENTRO do processo, de hora em hora, em vez de um systemd timer batendo
 * na API: um timer externo precisaria de credencial em disco ou de um endpoint
 * sem autenticação — as duas coisas pioram a segurança para automatizar o que
 * já está aqui dentro.
 *
 * `getGruposParaLembrar` é quem garante que ninguém é cobrado duas vezes no
 * mesmo ciclo e que grupo sem consentimento vigente fica de fora.
 */
function iniciarRotinaDeLembretes(intervaloMs = 3600_000) {
  const rodar = async () => {
    try {
      const pendentes = await getGruposParaLembrar(db);
      if (!pendentes.length) return;
      let enviados = 0;
      for (const g of pendentes) {
        const r = await dispararLembrete(g);
        if (r.ok) enviados++;
        else console.error(`[lembrete] ${g.nome}: ${r.erro}`);
      }
      console.log(`[lembrete] ${enviados}/${pendentes.length} enviados`);
    } catch (e) {
      // Nunca derruba o servidor por causa da rotina.
      console.error('[lembrete] falhou:', (e as Error).message);
    }
  };
  const timer = setInterval(rodar, intervaloMs);
  timer.unref?.();          // não segura o processo em pé sozinho
  setTimeout(rodar, 60_000).unref?.();   // primeira passada 1 min após subir
}

if (process.env.NODE_ENV !== 'test') {
  await garantirTabelaUsuarios(db);
  servidor.listen(PORTA, '127.0.0.1', () =>
    console.log(`whatsapp-monitor api em 127.0.0.1:${PORTA} (provider: ${provider.nome})`));
  if (process.env.LEMBRETES !== 'off') iniciarRotinaDeLembretes();
}

export { servidor, db };
