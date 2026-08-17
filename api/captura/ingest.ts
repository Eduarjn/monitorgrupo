/**
 * Ingestão da mensagem capturada.
 *
 * ⚠️ CORREÇÃO 4 — FILTRO ANTES DO DISCO.
 * A instância entrega `messages.upsert` de TODOS os chats do número: conversas
 * 1:1, grupos de família, grupos que ninguém vinculou. O desenho anterior
 * gravava no log e filtrava depois — ou seja, mensagem de terceiro sem base
 * legal tocava o disco antes de qualquer checagem.
 *
 * O fluxo agora é: normaliza em memória → é grupo? → o grupo está vinculado e
 * com consentimento vigente? → SÓ ENTÃO grava. O que não passa é descartado sem
 * deixar rastro de conteúdo em lugar nenhum, nem no log de webhook.
 */

import type { DB } from '../stats/queries.ts';
import type { MensagemCapturada } from './driver.ts';
import { hashCaptura, hashTexto, JANELA_RECONCILIACAO_SEG } from './chave.ts';
import { telefoneDoJid } from './driver.ts';

export type ResultadoIngestao =
  | { estado: 'gravada'; mensagem_id: number; grupo_id: number }
  | { estado: 'duplicada'; grupo_id: number }
  | { estado: 'descartada'; motivo: 'nao_e_grupo' | 'grupo_nao_vinculado' | 'sem_consentimento' | 'antes_da_captura' };

interface GrupoVinculado {
  id: number;
  captura_inicio_em: string | null;
  consentimento_ok: boolean;
}

/**
 * Descobre se o grupo remoto está autorizado. Uma query, com o gate de LGPD
 * junto — é o portão que decide se a mensagem pode existir no nosso disco.
 */
async function grupoAutorizado(db: DB, jid: string): Promise<GrupoVinculado | null> {
  const { rows } = await db.query<GrupoVinculado>(
    `select id::int as id, captura_inicio_em,
            consentimento_vigente(id) as consentimento_ok
       from grupos
      where wa_jid = $1 and ativo and captura_ativa
      limit 1`, [jid]);
  return rows[0] ?? null;
}

/**
 * Resolve a identidade real do autor.
 *
 * A captura traz o telefone de verdade (key.participant), coisa que o upload
 * nunca teve — o .txt só tem o nome da agenda. Isso resolve o risco 1.3 sem
 * tela de conciliação: a pessoa nasce já com telefone, e o alias serve para
 * casar depois com o que vier do .txt.
 */
async function resolverPessoa(
  db: DB, jid: string | null, nome: string | null, grupoId: number,
): Promise<number | null> {
  if (!jid) return null;

  const { rows: jaVisto } = await db.query<{ pessoa_id: number }>(
    `select pessoa_id::int as pessoa_id from wa_identidades where jid = $1`, [jid]);
  if (jaVisto[0]) return jaVisto[0].pessoa_id;

  const telefone = telefoneDoJid(jid);
  const exibicao = (nome ?? '').trim() || telefone || jid.split('@')[0];

  // @lid é identificador opaco: não dá para casar por telefone, então cria a
  // pessoa e deixa a conciliação manual para depois.
  const { rows } = telefone
    ? await db.query<{ id: number }>(
        `insert into pessoas (nome_exibicao, telefone_e164) values ($1, $2)
         on conflict (telefone_e164) do update set nome_exibicao = pessoas.nome_exibicao
         returning id::int as id`, [exibicao, telefone])
    : await db.query<{ id: number }>(
        `insert into pessoas (nome_exibicao) values ($1) returning id::int as id`, [exibicao]);

  const pessoaId = rows[0]?.id;
  if (!pessoaId) return null;

  await db.query(
    `insert into wa_identidades (jid, pessoa_id) values ($1, $2) on conflict (jid) do nothing`,
    [jid, pessoaId]);
  // O nome de exibição vira alias, que é como o .txt vai aparecer depois.
  if ((nome ?? '').trim()) {
    await db.query(
      `insert into pessoa_aliases (pessoa_id, alias, grupo_id) values ($1, $2, $3)
       on conflict do nothing`, [pessoaId, nome!.trim(), grupoId]);
  }
  return pessoaId;
}

/**
 * Grava a mensagem capturada.
 *
 * ⚠️ CORREÇÃO 1 — os DOIS índices únicos são tratados. `hash_mensagem` não
 * depende mais da instância, então repareamento não muda a chave; e o
 * `on conflict (grupo_id, wa_msg_id)` cobre explicitamente o outro índice.
 * Antes, um deles ficava descoberto e virava 23505 → 500 → retry em loop.
 */
export async function ingerirCaptura(db: DB, m: MensagemCapturada): Promise<ResultadoIngestao> {
  // ---- portão 1: é grupo? (o driver já filtra, isto é cinto e suspensório)
  if (!m.grupo_jid.endsWith('@g.us')) return { estado: 'descartada', motivo: 'nao_e_grupo' };

  // ---- portão 2: o grupo foi vinculado por um gestor?
  const grupo = await grupoAutorizado(db, m.grupo_jid);
  if (!grupo) return { estado: 'descartada', motivo: 'grupo_nao_vinculado' };

  // ---- portão 3: consentimento vigente (D7/D8 — captura contínua bloqueia)
  if (!grupo.consentimento_ok) return { estado: 'descartada', motivo: 'sem_consentimento' };

  // ---- portão 4: nada anterior ao momento em que a captura foi ligada.
  // O dump de pareamento do Baileys pode entregar conversa antiga; o passado é
  // domínio do upload, com o consentimento que valia na época.
  if (grupo.captura_inicio_em && m.enviada_em < new Date(grupo.captura_inicio_em)) {
    return { estado: 'descartada', motivo: 'antes_da_captura' };
  }

  const pessoaId = await resolverPessoa(db, m.autor_jid, m.autor_nome, grupo.id);

  const { rows } = await db.query<{ id: number }>(
    `insert into mensagens (grupo_id, autor_raw, pessoa_id, enviada_em, conteudo, tipo,
                            midia_arquivo, hash_mensagem, origem, wa_msg_id, autor_jid,
                            texto_hash, respondendo_a)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'captura',$9,$10,$11,$12)
     on conflict (grupo_id, hash_mensagem) do nothing
     returning id::int as id`,
    [grupo.id, m.autor_nome, pessoaId, m.enviada_em.toISOString(), m.conteudo, m.tipo,
     m.midia_arquivo, hashCaptura(m.grupo_jid, m.wa_msg_id), m.wa_msg_id, m.autor_jid,
     hashTexto(m.conteudo), m.respondendo_a],
  ).catch((e: { code?: string }) => {
    // 23505 no índice de wa_msg_id: mesma mensagem por outro caminho. É
    // duplicata, não falha — devolver 500 faria a Evolution retentar em loop.
    if (e?.code === '23505') return { rows: [] as Array<{ id: number }> };
    throw e;
  });

  if (!rows[0]) return { estado: 'duplicada', grupo_id: grupo.id };

  await db.query(
    `update wa_instancias set ultima_mensagem_em = now(), atualizado_em = now()
      where estado = 'conectado'`);

  return { estado: 'gravada', mensagem_id: rows[0].id, grupo_id: grupo.id };
}

/**
 * ⚠️ CORREÇÃO 3 — inserção em LOTE no upload.
 *
 * Antes: uma query por mensagem (60 mil linhas = 60 mil round-trips), e a
 * proposta de reconciliação com `where not exists` por linha teria dobrado isso.
 * Agora: um INSERT por lote, com `unnest`, e o NOT EXISTS avaliado dentro do
 * banco — o custo de rede deixa de crescer com o número de mensagens.
 *
 * ⚠️ CORREÇÃO 2 — o casamento com a captura usa texto + janela de ±90s, em vez
 * de minuto exato, porque o relógio do celular e o do servidor não coincidem.
 *
 * Devolve quantas entraram; quem chama calcula o resto por diferença.
 */
export interface LinhaUpload {
  autor_raw: string | null;
  enviada_em: string;
  conteudo: string;
  tipo: string;
  midia_arquivo: string | null;
  hash_mensagem: string;
}

export async function inserirLoteUpload(
  db: DB, grupoId: number, uploadId: number, linhas: LinhaUpload[], tamanhoLote = 500,
): Promise<{ novas: number; conciliadas: number }> {
  let novas = 0;
  let conciliadas = 0;

  for (let i = 0; i < linhas.length; i += tamanhoLote) {
    const lote = linhas.slice(i, i + tamanhoLote);
    const cols = {
      autor: lote.map((l) => l.autor_raw),
      enviada: lote.map((l) => l.enviada_em),
      conteudo: lote.map((l) => l.conteudo),
      tipo: lote.map((l) => l.tipo),
      midia: lote.map((l) => l.midia_arquivo),
      hash: lote.map((l) => l.hash_mensagem),
      thash: lote.map((l) => hashTexto(l.conteudo)),
    };

    const { rows } = await db.query<{ id: number }>(
      `insert into mensagens (grupo_id, upload_id, autor_raw, enviada_em, conteudo, tipo,
                              midia_arquivo, hash_mensagem, origem, texto_hash)
       select $1, $2, u.autor, u.enviada::timestamptz, u.conteudo, u.tipo, u.midia,
              u.hash, 'upload', u.thash
         from unnest($3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[])
              as u(autor, enviada, conteudo, tipo, midia, hash, thash)
        where u.thash is null
           or not exists (
             select 1 from mensagens c
              where c.grupo_id   = $1
                and c.origem     = 'captura'
                and c.texto_hash = u.thash
                and c.enviada_em between u.enviada::timestamptz - make_interval(secs => $10)
                                     and u.enviada::timestamptz + make_interval(secs => $10)
           )
       on conflict (grupo_id, hash_mensagem) do nothing
       returning id::int as id`,
      [grupoId, uploadId, cols.autor, cols.enviada, cols.conteudo, cols.tipo,
       cols.midia, cols.hash, cols.thash, JANELA_RECONCILIACAO_SEG],
    );
    novas += rows.length;

    // Quantas foram BARRADAS pela conciliação (e não por já existirem). Uma
    // query por lote, não por linha — é o que permite dizer ao usuário
    // "12 já estavam capturadas em tempo real" sem inventar o número.
    const { rows: conc } = await db.query<{ n: number }>(
      `select count(*)::int as n
         from unnest($2::text[], $3::text[]) as u(enviada, thash)
        where u.thash is not null
          and exists (
            select 1 from mensagens c
             where c.grupo_id   = $1
               and c.origem     = 'captura'
               and c.texto_hash = u.thash
               and c.enviada_em between u.enviada::timestamptz - make_interval(secs => $4)
                                    and u.enviada::timestamptz + make_interval(secs => $4)
          )`,
      [grupoId, cols.enviada, cols.thash, JANELA_RECONCILIACAO_SEG]);
    conciliadas += conc[0]?.n ?? 0;
  }

  return { novas, conciliadas };
}
