/** Cria/atualiza um usuário do painel. Uso: node --experimental-strip-types criar-usuario.mts email senha "Nome" */
import { randomUUID } from 'node:crypto';
import { hashSenha } from './api/auth/auth.ts';
const [email, senha, nome] = process.argv.slice(2);
if (!email || !senha) { console.error('uso: criar-usuario.mts <email> <senha> [nome]'); process.exit(1); }
console.log(JSON.stringify({ id: randomUUID(), email, hash: await hashSenha(senha), nome: nome ?? null }));
