/**
 * Testes da Fase 5 — rodam inteiros no MockProvider, sem chave e sem custo.
 * A integração com pgvector de verdade é validada à parte, contra o banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MockProvider, criarProvider, estimarTokens } from '../provider.ts';
import { montarBlocos, estimarCustoEmbedding, type MensagemParaBloco } from '../embed.ts';

const msg = (id: number, hhmm: string, autor: string, conteudo: string): MensagemParaBloco => ({
  id, enviada_em: `2026-08-11T${hhmm}:00`, autor, conteudo,
});

// ------------------------------------------------------------------- janelas

test('silêncio maior que o corte abre um bloco novo', () => {
  const blocos = montarBlocos(
    [
      msg(1, '09:00', 'Ana', 'bom dia'),
      msg(2, '09:05', 'Bia', 'bom dia!'),
      msg(3, '11:30', 'Ana', 'voltei'),   // 2h25 de silêncio → novo bloco
      msg(4, '11:31', 'Bia', 'oi'),
    ],
    { minutosDeCorte: 15 },
  );
  assert.equal(blocos.length, 2);
  assert.deepEqual(blocos[0].mensagem_ids, [1, 2]);
  assert.deepEqual(blocos[1].mensagem_ids, [3, 4]);
  assert.equal(blocos[0].inicio_em, '2026-08-11T09:00:00');
  assert.equal(blocos[0].fim_em, '2026-08-11T09:05:00');
});

test('conversa contínua vira um bloco só', () => {
  const seguidas = Array.from({ length: 10 }, (_, i) =>
    msg(i + 1, `10:${String(i * 1).padStart(2, '0')}`, 'Ana', `linha ${i}`));
  const blocos = montarBlocos(seguidas, { minutosDeCorte: 15 });
  assert.equal(blocos.length, 1);
  assert.equal(blocos[0].mensagem_ids.length, 10);
});

test('teto de mensagens corta o bloco mesmo sem silêncio', () => {
  const muitas = Array.from({ length: 25 }, (_, i) => msg(i + 1, '10:00', 'Ana', `x${i}`));
  const blocos = montarBlocos(muitas, { maxMensagens: 10 });
  assert.deepEqual(blocos.map((b) => b.mensagem_ids.length), [10, 10, 5]);
});

test('teto de caracteres protege o contexto do modelo', () => {
  const longas = Array.from({ length: 6 }, (_, i) => msg(i + 1, '10:00', 'Ana', 'y'.repeat(300)));
  const blocos = montarBlocos(longas, { maxCaracteres: 1000 });
  assert.ok(blocos.length >= 2);
  assert.ok(blocos.every((b) => b.texto.length <= 1400));  // 1000 + prefixos
});

test('o texto do bloco preserva QUEM disse o quê', () => {
  const [bloco] = montarBlocos([msg(1, '14:07', 'João Silva', 'fechado')]);
  assert.equal(bloco.texto, '14:07 João Silva: fechado');
});

test('mensagem vazia (mídia) não entra no vetor', () => {
  const blocos = montarBlocos([
    msg(1, '09:00', 'Ana', 'texto real'),
    msg(2, '09:01', 'Bia', '   '),
    msg(3, '09:02', 'Ana', 'outro texto'),
  ]);
  assert.equal(blocos.length, 1);
  assert.deepEqual(blocos[0].mensagem_ids, [1, 3]);
});

test('lista vazia não quebra', () => {
  assert.deepEqual(montarBlocos([]), []);
});

// -------------------------------------------------------------------- custo

test('estimativa de custo cresce com o volume e é reportável antes de gastar', () => {
  const blocos = montarBlocos(
    Array.from({ length: 100 }, (_, i) => msg(i + 1, '10:00', 'Ana', 'mensagem de teste '.repeat(5))),
    { maxMensagens: 10 },
  );
  const c = estimarCustoEmbedding(blocos);
  assert.equal(c.blocos, 10);
  assert.ok(c.tokens > 0);
  assert.ok(c.usd !== null && c.usd > 0 && c.usd < 0.01);   // centavos de centavo
});

test('estimarTokens aproxima 4 caracteres por token', () => {
  assert.equal(estimarTokens('12345678'), 2);
});

// ----------------------------------------------------------------- provider

test('mock: embeddings são determinísticos e normalizados', async () => {
  const p = new MockProvider(64);
  const [a] = await p.embed(['reunião de segunda com o cliente']);
  const [b] = await p.embed(['reunião de segunda com o cliente']);
  assert.deepEqual(a, b);
  assert.equal(a.length, 64);
  const norma = Math.hypot(...a);
  assert.ok(Math.abs(norma - 1) < 1e-9);
});

test('mock: texto parecido fica mais próximo que texto diferente (cosseno)', async () => {
  const p = new MockProvider(256);
  const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
  const [alvo, parecido, distinto] = await p.embed([
    'proposta comercial para o cliente novo',
    'proposta comercial enviada ao cliente',
    'churrasco de sábado na praia',
  ]);
  assert.ok(cos(alvo, parecido) > cos(alvo, distinto));
});

test('mock: sem contexto, answer recusa em vez de inventar', async () => {
  const p = new MockProvider();
  assert.match(await p.answer('o que falaram?', []), /Não encontrei/);
});

test('mock: answer cita as datas dos trechos', async () => {
  const p = new MockProvider();
  const r = await p.answer('e a proposta?', [
    { bloco_id: 1, inicio_em: '2026-08-03T09:00:00', fim_em: '2026-08-03T09:20:00', texto: '...' },
  ]);
  assert.match(r, /2026-08-03/);
});

test('fábrica cai no mock sem OPENAI_API_KEY e usa OpenAI quando há chave', () => {
  assert.equal(criarProvider({}).nome, 'mock');
  assert.equal(criarProvider({ OPENAI_API_KEY: 'sk-teste' }).nome, 'openai');
});

test('dimensão do mock casa com a coluna vector(1536) do schema', () => {
  assert.equal(new MockProvider().dimensaoEmbedding, 1536);
});

// --------------------------------------------- regressão: fuso nos blocos

test('bloco guarda o INSTANTE em UTC e mostra a hora LOCAL no texto', () => {
  // 09:14 em São Paulo == 12:14 UTC. O texto lido pelo modelo deve dizer 09:14,
  // mas inicio_em precisa ser o instante absoluto — senão a citação do RAG sai
  // 3 horas deslocada (bug encontrado no teste ponta a ponta da Fase 6).
  const [bloco] = montarBlocos([
    { id: 1, enviada_em: '2026-08-03T12:14:00Z', hora_local: '09:14', autor: 'Ana', conteudo: 'bom dia' },
  ]);
  assert.equal(bloco.inicio_em, '2026-08-03T12:14:00Z');
  assert.equal(bloco.texto, '09:14 Ana: bom dia');
});

// ------------------------------------------------------------------ Gemini

test('criarProvider: Gemini tem precedência e mantém 1536 dimensões', () => {
  const p = criarProvider({ GEMINI_API_KEY: 'x' } as never);
  assert.equal(p.nome, 'gemini');
  // 1536 é o que `blocos.embedding vector(1536)` espera — trocar de provedor
  // não pode exigir migração de coluna.
  assert.equal(p.dimensaoEmbedding, 1536);
});

test('criarProvider: IA_PROVIDER força a escolha e mock sempre vence', () => {
  const ambas = { GEMINI_API_KEY: 'x', OPENAI_API_KEY: 'y' } as never;
  assert.equal(criarProvider(ambas).nome, 'gemini');
  assert.equal(criarProvider({ ...ambas as object, IA_PROVIDER: 'openai' } as never).nome, 'openai');
  assert.equal(criarProvider({ ...ambas as object, IA_PROVIDER: 'mock' } as never).nome, 'mock');
});

test('criarProvider: sem chave nenhuma cai no mock', () => {
  assert.equal(criarProvider({} as never).nome, 'mock');
});
