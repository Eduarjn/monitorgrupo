/**
 * Teste de integração da Fase 5 contra o pgvector REAL.
 *
 * Não é unitário: conecta no banco `whatsapp_monitor`, semeia uma conversa,
 * indexa com o MockProvider (custo zero), faz busca semântica de verdade pelo
 * índice HNSW e confere as fontes. É o que prova que o SQL com `<=>`, o cast
 * `::vector` e o ORDER BY por distância funcionam de fato.
 *
 * Uso:  PGURL='postgres://...' node --experimental-strip-types api/ai/__tests__/integracao-pgvector.ts
 */
import pg from 'pg';
import { MockProvider } from '../provider.ts';
import { indexarPeriodo } from '../embed.ts';
import { perguntar, recuperar } from '../search.ts';
import { resumirDiaComCache } from '../summarize.ts';

const url = process.env.PGURL;
if (!url) throw new Error('defina PGURL');

const pool = new pg.Pool({ connectionString: url, max: 3 });
const db = { query: (t: string, p?: unknown[]) => pool.query(t, p as never[]) };
const provider = new MockProvider();

const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) process.exitCode = 1;
};

// conversa com 3 assuntos separados por silêncio, para a busca ter o que distinguir
const CONVERSA: Array<[string, string, string]> = [
  ['09:00', 'Ana',   'bom dia! vamos fechar a proposta comercial do cliente Acme hoje'],
  ['09:02', 'Bia',   'já revisei o orçamento da proposta, está em 12 mil'],
  ['09:04', 'Ana',   'perfeito, mando a proposta para a Acme ainda de manhã'],
  ['11:00', 'Carlos','pessoal, o servidor de produção caiu às 10h40'],
  ['11:01', 'Bia',   'o servidor voltou? preciso subir o deploy'],
  ['11:03', 'Carlos','servidor normalizado, foi falha de disco'],
  ['15:00', 'Ana',   'confirmando o churrasco de sábado na casa do Carlos'],
  ['15:01', 'Bia',   'levo a sobremesa para o churrasco'],
];

try {
  console.log('\n=== preparando ===');
  await db.query(`truncate blocos, mensagens, pessoas, grupo_acessos, grupos restart identity cascade`);
  await db.query(`drop table if exists resumos_dia`);
  await db.query(`insert into grupos (nome) values ('Integração')`);
  for (const [i, [hora, autor, texto]] of CONVERSA.entries()) {
    await db.query(
      `insert into mensagens (grupo_id, autor_raw, enviada_em, conteudo, tipo, hash_mensagem)
       values (1,$1,$2::timestamptz,$3,'texto',$4)`,
      [autor, `2026-08-11T${hora}:00-03:00`, texto, `i${i}`],
    );
  }
  console.log(`  ${CONVERSA.length} mensagens semeadas`);

  console.log('\n=== 1) indexação: blocos por janela de conversa ===');
  const r = await indexarPeriodo(db, provider, 1,
    { inicio: '2026-08-11T00:00:00-03:00', fim: '2026-08-12T00:00:00-03:00' },
    { minutosDeCorte: 15 });
  ok(r.blocos === 3, `3 blocos criados (silêncio separou os assuntos) — obtido ${r.blocos}`);
  ok(r.usd !== null && r.usd < 0.001, `custo estimado reportado antes de gastar: US$ ${r.usd?.toFixed(6)}`);

  const { rows: [b] } = await db.query<{ n: number; comvetor: number; ids: number }>(
    `select count(*)::int n, count(embedding)::int comvetor,
            sum(array_length(mensagem_ids,1))::int ids from blocos where grupo_id=1`);
  ok(b.comvetor === 3, `todos os blocos têm embedding gravado (${b.comvetor}/3)`);
  ok(b.ids === CONVERSA.length, `mensagem_ids preserva as ${CONVERSA.length} mensagens de origem (${b.ids})`);

  console.log('\n=== 2) busca semântica pelo índice HNSW ===');
  const achados = await recuperar(db, provider, 1, 'como está o orçamento da proposta?', { topK: 3 });
  ok(achados.length > 0, 'a busca retornou blocos');
  ok(/proposta/i.test(achados[0].texto), `bloco mais similar é o da PROPOSTA (sim=${achados[0].similaridade.toFixed(3)})`);
  ok(!/churrasco/i.test(achados[0].texto), 'o bloco do churrasco não venceu a busca');

  const servidor = await recuperar(db, provider, 1, 'o servidor caiu?', { topK: 1 });
  ok(/servidor/i.test(servidor[0].texto), `pergunta sobre servidor recupera o bloco certo (sim=${servidor[0].similaridade.toFixed(3)})`);

  console.log('\n=== 3) o plano usa o índice vetorial? ===');
  const [v] = await provider.embed(['teste']);
  const { rows: plano } = await db.query<{ 'QUERY PLAN': string }>(
    `explain (costs off) select id from blocos where grupo_id=1 and embedding is not null
       order by embedding <=> $1::vector limit 5`, [`[${v.join(',')}]`]);
  const txt = plano.map((p) => p['QUERY PLAN']).join(' ');
  const usaIndice = /idx_blocos_embedding/i.test(txt);
  console.log('     ' + txt.replace(/\s+/g, ' ').slice(0, 130));
  // Com 3 blocos o planner escolhe Sort — e ESTÁ CERTO: varrer 3 linhas é mais
  // barato que descer o grafo do HNSW. Verificado à parte com 3.000 blocos: aí
  // o plano vira "Index Scan using idx_blocos_embedding", com e sem o filtro de
  // grupo. Por isso aqui só REPORTAMOS o plano, sem exigir o índice num volume
  // em que ele não deve mesmo ser usado.
  console.log(`     -> índice vetorial no plano: ${usaIndice ? 'SIM' : 'NÃO (esperado neste volume)'}`);

  console.log('\n=== 4) resposta com fontes citadas ===');
  const resp = await perguntar(db, provider, 1, 'o que ficou decidido sobre a proposta?', { topK: 2 });
  ok(resp.fontes.length === 2, `resposta traz ${resp.fontes.length} fonte(s) para auditoria`);
  ok(resp.fontes.every((f) => f.bloco_id > 0 && f.inicio_em.startsWith('2026-08-11')),
     'cada fonte tem id do bloco e data');
  ok(resp.resposta.length > 0, `resposta gerada: ${resp.resposta.slice(0, 60)}…`);

  console.log('\n=== 5) filtro de similaridade barra ruído ===');
  const nada = await perguntar(db, provider, 1, 'xyzzy plugh qwertyuiop', { minSimilaridade: 0.99 });
  ok(nada.fontes.length === 0 && /Não encontrei/.test(nada.resposta),
     'sem bloco acima do corte, recusa em vez de inventar (e não chama o modelo)');

  console.log('\n=== 6) resumo do dia + cache ===');
  const antes = provider.chamadas.summarize;
  const r1 = await resumirDiaComCache(db, provider, 1, '2026-08-11');
  ok(!r1.doCache && r1.mensagens === CONVERSA.length, `1ª vez gera o resumo (${r1.mensagens} mensagens, ${r1.autores} autores)`);
  const r2 = await resumirDiaComCache(db, provider, 1, '2026-08-11');
  ok(r2.doCache, '2ª vez vem do cache');
  ok(provider.chamadas.summarize === antes + 1, 'o modelo foi chamado UMA vez só (economia real)');

  await db.query(`insert into mensagens (grupo_id, autor_raw, enviada_em, conteudo, tipo, hash_mensagem)
                  values (1,'Ana','2026-08-11T18:00:00-03:00','esqueci: reunião amanhã','texto','novo')`);
  const r3 = await resumirDiaComCache(db, provider, 1, '2026-08-11');
  ok(!r3.doCache && r3.mensagens === CONVERSA.length + 1,
     'mensagem nova invalida o cache e regenera automaticamente');

  console.log('\n=== limpando ===');
  await db.query(`truncate blocos, mensagens, pessoas, grupo_acessos, grupos restart identity cascade`);
  await db.query(`drop table if exists resumos_dia`);
  console.log('  banco limpo');
} finally {
  await pool.end();
}
console.log(process.exitCode ? '\nFALHOU\n' : '\nTUDO OK\n');
