/**
 * Testes da Opção A — criptografia do token, sanitização e agenda de coleta.
 * Tudo offline: nenhuma chamada de rede, nenhum banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { abrir, chaveDaVersao, dica, sanitizar, selar, versaoAtiva } from '../cripto.ts';
import { variaveisDoLembrete } from '../calliope.ts';
import { normalizarDestino, proximaColeta } from '../../coleta/queries.ts';

const chave = () => randomBytes(32).toString('base64');
const env = (extra: Record<string, string> = {}) =>
  ({ CONEXAO_CHAVE_V1: chave(), CONEXAO_CHAVE_ATIVA: '1', ...extra }) as NodeJS.ProcessEnv;

// ------------------------------------------------------------------- cripto

test('cripto: ida e volta preserva o token', () => {
  const e = env();
  const token = 'Bearer abc123$com$cifrao';
  assert.equal(abrir(selar(token, e), e), token);
});

test('cripto: cada selagem usa IV novo — mesmo texto, ciphertext diferente', () => {
  const e = env();
  const a = selar('mesmo-token', e);
  const b = selar('mesmo-token', e);
  assert.notEqual(a.iv.toString('hex'), b.iv.toString('hex'));
  assert.notEqual(a.cifrado.toString('hex'), b.cifrado.toString('hex'));
  // ...e ainda assim os dois abrem no mesmo valor
  assert.equal(abrir(a, e), abrir(b, e));
});

test('cripto: chave errada FALHA em vez de devolver lixo', () => {
  const selado = selar('segredo', env());
  const outra = env();   // chave diferente
  assert.throws(() => abrir(selado, outra));
});

test('cripto: adulterar o ciphertext é detectado pela tag do GCM', () => {
  const e = env();
  const s = selar('segredo', e);
  s.cifrado[0] ^= 0xff;
  assert.throws(() => abrir(s, e));
});

test('cripto: rotação — a chave nova cifra e a antiga ainda abre', () => {
  const v1 = chave();
  const e1 = { CONEXAO_CHAVE_V1: v1, CONEXAO_CHAVE_ATIVA: '1' } as NodeJS.ProcessEnv;
  const antigo = selar('token-antigo', e1);

  const e2 = { CONEXAO_CHAVE_V1: v1, CONEXAO_CHAVE_V2: chave(),
               CONEXAO_CHAVE_ATIVA: '2' } as NodeJS.ProcessEnv;
  const novo = selar('token-novo', e2);

  assert.equal(novo.versao, 2);
  assert.equal(abrir(novo, e2), 'token-novo');
  // o que já estava gravado continua legível
  assert.equal(abrir(antigo, e2), 'token-antigo');
});

test('cripto: chave ausente ou de tamanho errado dá erro explicativo', () => {
  assert.throws(() => chaveDaVersao(9, env()), /CONEXAO_CHAVE_V9/);
  const curta = { CONEXAO_CHAVE_V1: Buffer.alloc(8).toString('base64') } as NodeJS.ProcessEnv;
  assert.throws(() => chaveDaVersao(1, curta), /32 bytes/);
});

test('versaoAtiva: padrão 1, recusa valor inválido', () => {
  assert.equal(versaoAtiva({} as NodeJS.ProcessEnv), 1);
  assert.throws(() => versaoAtiva({ CONEXAO_CHAVE_ATIVA: '0' } as NodeJS.ProcessEnv));
});

// -------------------------------------------------------------- sanitização

test('sanitizar: remove segredo em qualquer profundidade', () => {
  const limpo = sanitizar({
    ok: true,
    eco: { token: 'sk-vazando', authorization: 'Bearer x', nome: 'lembrete' },
    lista: [{ api_key: 'abc' }],
  }) as Record<string, never>;
  const txt = JSON.stringify(limpo);
  assert.ok(!txt.includes('sk-vazando'), 'token não pode sobrar');
  assert.ok(!txt.includes('Bearer x'), 'authorization não pode sobrar');
  assert.ok(!txt.includes('abc'), 'api_key não pode sobrar');
  assert.ok(txt.includes('lembrete'), 'o que não é segredo continua');
});

test('dica: revela só o fim, e nada de segredo curto', () => {
  assert.equal(dica('abcdefghijklmnop'), '••••mnop');
  assert.equal(dica('curto'), '••••••');
});

// ----------------------------------------------------------------- agenda

test('proximaColeta: semanal soma 7 dias, diaria 1, manual não agenda', () => {
  const base = new Date('2026-08-14T12:00:00Z');
  assert.equal(proximaColeta('semanal', base)?.toISOString(), '2026-08-21T12:00:00.000Z');
  assert.equal(proximaColeta('diaria', base)?.toISOString(), '2026-08-15T12:00:00.000Z');
  assert.equal(proximaColeta('manual', base), null);
});

test('proximaColeta: não muta a data recebida', () => {
  const base = new Date('2026-08-14T12:00:00Z');
  proximaColeta('semanal', base);
  assert.equal(base.toISOString(), '2026-08-14T12:00:00.000Z');
});

test('normalizarDestino: aceita formatos humanos e recusa lixo', () => {
  assert.equal(normalizarDestino('(19) 93501-0887'), '5519935010887');
  assert.equal(normalizarDestino('5519935010887'), '5519935010887');
  assert.equal(normalizarDestino('19 3407-1000'), '551934071000');
  assert.equal(normalizarDestino('123'), null);
  assert.equal(normalizarDestino(''), null);
});

test('variaveisDoLembrete: texto de tempo em português, com singular correto', () => {
  assert.deepEqual(variaveisDoLembrete('Comercial ERA', 1), ['Comercial ERA', '1 dia']);
  assert.deepEqual(variaveisDoLembrete('Comercial ERA', 9), ['Comercial ERA', '9 dias']);
  assert.deepEqual(variaveisDoLembrete('Comercial ERA', 0), ['Comercial ERA', 'menos de um dia']);
  assert.deepEqual(variaveisDoLembrete('Comercial ERA', null),
                   ['Comercial ERA', 'ainda sem nenhuma coleta']);
});
