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

const PORTA = Number(process.env.PORTA ?? 3020);
const SEGREDO = process.env.JWT_SECRET ?? '';
const ORIGENS = (process.env.ORIGENS_PERMITIDAS ?? 'http://localhost:5173').split(',');

if (!SEGREDO) throw new Error('JWT_SECRET é obrigatório (use o mesmo segredo do PostgREST).');

const pool = new pg.Pool({ connectionString: process.env.PGURL, max: 8 });
const db: DB = { query: (t, p) => pool.query(t, p as never[]) };
const provider = criarProvider();

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

  const usuario = usuarioDaRequisicao(req);   // daqui para baixo, tudo autenticado

  if (rota === '/auth/eu') return { usuario };

  // ---- grupos -------------------------------------------------------------
  if (rota === '/grupos') {
    const { rows } = await db.query(
      `select g.id, g.nome, g.descricao, g.frequencia_coleta, g.ultima_coleta_em, a.papel,
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
    await db.query(`update grupos set ultima_coleta_em = now() where id = $1`, [g]);

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
    // Mensagem genérica em 500: detalhe interno não vaza para o cliente.
    responder(res, status, { erro: status >= 500 ? 'Erro interno.' : erro.message });
  }
});

if (process.env.NODE_ENV !== 'test') {
  await garantirTabelaUsuarios(db);
  servidor.listen(PORTA, '127.0.0.1', () =>
    console.log(`whatsapp-monitor api em 127.0.0.1:${PORTA} (provider: ${provider.nome})`));
}

export { servidor, db };
