/**
 * Segredo em repouso — AES-256-GCM.
 *
 * O token do canal de aviso é cadastrado pela interface e precisa ser usado de
 * volta (a API do Calliope quer o token em claro na chamada), então não serve
 * hash: tem que ser cifra reversível. GCM porque autentica além de cifrar — se
 * alguém adulterar a linha no banco, `abrir()` lança em vez de devolver lixo.
 *
 * A chave NUNCA vive no banco. Se vivesse, cifrar não protegeria de nada: quem
 * lê a tabela leria a chave junto. Ela fica no EnvironmentFile do systemd.
 *
 * `versao` permite rotação: a chave nova passa a cifrar, as antigas continuam
 * decifrando o que já existe.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SegredoSelado {
  cifrado: Buffer;
  iv: Buffer;
  tag: Buffer;
  versao: number;
}

const ALGO = 'aes-256-gcm';
const TAM_IV = 12;    // recomendado para GCM
const TAM_CHAVE = 32; // 256 bits

/** Lê CONEXAO_CHAVE_V<n> do ambiente. Erro explícito é melhor que cifra fraca. */
export function chaveDaVersao(versao: number, env: NodeJS.ProcessEnv = process.env): Buffer {
  const bruta = env[`CONEXAO_CHAVE_V${versao}`];
  if (!bruta) {
    throw new Error(
      `CONEXAO_CHAVE_V${versao} não está definida. ` +
      'Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const chave = Buffer.from(bruta, 'base64');
  if (chave.length !== TAM_CHAVE) {
    throw new Error(`CONEXAO_CHAVE_V${versao} precisa ter 32 bytes em base64 (tem ${chave.length}).`);
  }
  return chave;
}

/** Qual versão cifra os segredos novos. As anteriores seguem válidas para abrir. */
export function versaoAtiva(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.CONEXAO_CHAVE_ATIVA ?? 1);
  if (!Number.isInteger(v) || v < 1) throw new Error('CONEXAO_CHAVE_ATIVA deve ser inteiro >= 1.');
  return v;
}

export function selar(texto: string, env: NodeJS.ProcessEnv = process.env): SegredoSelado {
  if (!texto) throw new Error('Nada a cifrar.');
  const versao = versaoAtiva(env);
  const iv = randomBytes(TAM_IV);
  const cifra = createCipheriv(ALGO, chaveDaVersao(versao, env), iv);
  const cifrado = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  return { cifrado, iv, tag: cifra.getAuthTag(), versao };
}

export function abrir(s: SegredoSelado, env: NodeJS.ProcessEnv = process.env): string {
  const decifra = createDecipheriv(ALGO, chaveDaVersao(s.versao, env), s.iv);
  decifra.setAuthTag(s.tag);
  // Lança se a tag não bater — adulteração ou chave errada, nunca silencioso.
  return Buffer.concat([decifra.update(s.cifrado), decifra.final()]).toString('utf8');
}

/**
 * Mostra o fim do segredo para o usuário confirmar que cadastrou o token certo,
 * sem expor o valor. Segredo curto vira só asteriscos: revelar 4 de 6 caracteres
 * não é "mascarar".
 */
export function dica(texto: string): string {
  if (texto.length < 12) return '••••••';
  return '••••' + texto.slice(-4);
}

const CAMPOS_SENSIVEIS = /^(token|access_token|senha|password|secret|client_secret|authorization|pin|apikey|api_key)$/i;

/**
 * Remove segredo de qualquer objeto antes de logar ou gravar em `detalhe`.
 * Vale para o eco da API do Calliope, que devolve parte do payload enviado.
 */
export function sanitizar(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 6 || valor == null) return valor;
  if (Array.isArray(valor)) return valor.map((v) => sanitizar(v, profundidade + 1));
  if (typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      saida[k] = CAMPOS_SENSIVEIS.test(k) ? '[removido]' : sanitizar(v, profundidade + 1);
    }
    return saida;
  }
  return valor;
}
