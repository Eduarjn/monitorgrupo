/**
 * whatsapp-monitor — autenticação.
 *
 * POR QUE NÃO O SUPABASE AUTH (gotrue):
 * o gotrue da instância roda contra o banco `postgres` (do EraLearn). Nosso banco
 * é o `whatsapp_monitor`, separado de propósito (D4) — o gotrue não o alcança.
 *
 * A solução mantém a COMPATIBILIDADE que importa: emitimos um JWT HS256 com o
 * MESMO segredo do PostgREST e com `sub` = uuid do usuário. É exatamente o que
 * `auth.uid()` (Fase 1) lê do GUC `request.jwt.claims`, então todo o RLS por
 * `grupo_acessos` continua valendo sem alterar uma linha de política.
 *
 * Senha: scrypt (nativo do Node, resistente a GPU) com sal aleatório por usuário
 * e comparação em tempo constante.
 */

import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from '../stats/queries.ts';

const scryptAsync = promisify(scrypt) as (
  senha: string, sal: Buffer, tamanho: number,
) => Promise<Buffer>;

const TAMANHO_HASH = 64;
const VALIDADE_HORAS = 12;

export interface UsuarioSessao {
  id: string;
  email: string;
  nome: string | null;
  /**
   * Só informativo, para a interface decidir o que mostrar. A autorização de
   * verdade (`exigirAdmin`) relê do banco a cada chamada — papel dentro de um
   * JWT de 12h continuaria valendo depois de ser revogado.
   */
  papel_global?: 'usuario' | 'admin';
}

// ------------------------------------------------------------------- senha

export async function hashSenha(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scryptAsync(senha, sal, TAMANHO_HASH);
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`;
}

export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const [algoritmo, salHex, hashHex] = guardado.split('$');
  if (algoritmo !== 'scrypt' || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const obtido = await scryptAsync(senha, Buffer.from(salHex, 'hex'), esperado.length);
  // timingSafeEqual evita descobrir a senha medindo o tempo de resposta
  return obtido.length === esperado.length && timingSafeEqual(obtido, esperado);
}

// --------------------------------------------------------------------- JWT

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function emitirToken(usuario: UsuarioSessao, segredo: string): string {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    sub: usuario.id,                 // <- é isto que auth.uid() lê
    email: usuario.email,
    role: 'authenticated',           // <- papel que o PostgREST/RLS espera
    iat: agora,
    exp: agora + VALIDADE_HORAS * 3600,
  }));
  const assinatura = b64url(createHmac('sha256', segredo).update(`${cabecalho}.${corpo}`).digest());
  return `${cabecalho}.${corpo}.${assinatura}`;
}

export function verificarToken(token: string, segredo: string): UsuarioSessao | null {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [cabecalho, corpo, assinatura] = partes;

  const esperada = b64url(createHmac('sha256', segredo).update(`${cabecalho}.${corpo}`).digest());
  const a = Buffer.from(assinatura), b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    if (!dados.sub || (dados.exp && dados.exp < Math.floor(Date.now() / 1000))) return null;
    return { id: dados.sub, email: dados.email, nome: dados.nome ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- usuários

/** Tabela de usuários do painel. Criada na primeira execução. */
export async function garantirTabelaUsuarios(db: DB): Promise<void> {
  await db.query(`
    create table if not exists usuarios (
      id         uuid primary key,
      email      text not null unique,
      senha_hash text not null,
      nome       text,
      ativo      boolean not null default true,
      criado_em  timestamptz not null default now(),
      ultimo_acesso timestamptz
    )`);
  // Autorização de CONTA (não de grupo). `grupo_acessos` resolve quem lê qual
  // grupo, mas o canal de aviso é um só para o painel inteiro: sem este papel,
  // gestor de um grupo qualquer poderia trocar o token do WhatsApp da ERA.
  await db.query(
    `alter table usuarios add column if not exists papel_global text not null default 'usuario'`,
  );
  await db.query(`
    do $$ begin
      alter table usuarios add constraint usuarios_papel_global_check
        check (papel_global in ('usuario','admin'));
    exception when duplicate_object then null; end $$`);
  // Sem GRANT para anon/authenticated: a tabela de senhas NUNCA é exposta pelo
  // PostgREST. Só o backend (service_role) a enxerga.
  await db.query(`revoke all on usuarios from anon, authenticated`).catch(() => {});
}

export async function criarUsuario(
  db: DB, email: string, senha: string, nome?: string,
): Promise<UsuarioSessao> {
  const id = randomUUID();
  const hash = await hashSenha(senha);
  const { rows } = await db.query<UsuarioSessao>(
    `insert into usuarios (id, email, senha_hash, nome) values ($1, lower($2), $3, $4)
     on conflict (email) do update set senha_hash = excluded.senha_hash, nome = excluded.nome
     returning id, email, nome`,
    [id, email, hash, nome ?? null],
  );
  return rows[0];
}

export async function autenticar(
  db: DB, email: string, senha: string,
): Promise<UsuarioSessao | null> {
  const { rows } = await db.query<UsuarioSessao & { senha_hash: string; ativo: boolean }>(
    `select id, email, nome, papel_global, senha_hash, ativo from usuarios where email = lower($1)`,
    [email],
  );
  const u = rows[0];
  // Mesmo sem usuário, gastamos o tempo de um scrypt: sem isso, a diferença de
  // tempo entre "e-mail existe" e "não existe" vira enumeração de contas.
  if (!u) {
    await hashSenha(senha);
    return null;
  }
  if (!u.ativo) return null;
  if (!(await conferirSenha(senha, u.senha_hash))) return null;

  await db.query(`update usuarios set ultimo_acesso = now() where id = $1`, [u.id]);
  return { id: u.id, email: u.email, nome: u.nome, papel_global: u.papel_global ?? 'usuario' };
}
