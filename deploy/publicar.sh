#!/usr/bin/env bash
#
# Publica a API e o frontend do monitor no servidor 138.59.144.162.
#
# Roda da RAIZ do repositório:
#   bash deploy/publicar.sh
#
# O script descobre o caminho dos estáticos lendo o nginx do servidor em vez de
# assumir um diretório fixo: errar o destino aqui significa publicar por cima do
# EraLearn ou do ERAREASON, que dividem a mesma máquina.
#
# Faz backup do que está no ar antes de sobrescrever, e reverte sozinho se o
# serviço não voltar. Já derrubamos a API por 40s uma vez por publicar um bundle
# quebrado — a rede de segurança existe por causa disso.

set -euo pipefail

HOST=138.59.144.162
PORTA_SSH=5022
USUARIO=root
CHAVE="${CHAVE_SSH:-$HOME/OneDrive/Desktop/CHAVEZ_new/treinamento.pem}"
DESTINO=/opt/whatsapp-monitor
SERVICO=whatsapp-monitor.service

sr() { ssh -i "$CHAVE" -p "$PORTA_SSH" -o ConnectTimeout=15 "$USUARIO@$HOST" "$@"; }

# ---------------------------------------------------------------- 0. checagens
[[ -f "$CHAVE" ]] || { echo "✗ chave não encontrada: $CHAVE"; exit 1; }
[[ -f package.json ]] || { echo "✗ rode da raiz do repositório."; exit 1; }

echo "▸ compilando…"
npm test --silent >/dev/null || { echo "✗ testes falharam — nada foi publicado."; exit 1; }
npm run build:api --silent
[[ -s dist/server.mjs ]] || { echo "✗ bundle da API vazio."; exit 1; }

# O bundle PRECISA manter 'pg' externo; embutido, o driver quebra em runtime.
grep -q "from *[\"']pg[\"']" dist/server.mjs \
  || { echo "✗ 'pg' foi embutido no bundle — faltou --external:pg."; exit 1; }

echo "▸ conectando…"
sr 'true' || { echo "✗ sem SSH. Confira a porta 5022 e a chave."; exit 1; }

# O frontend NAO fica neste servidor: o painel roda na Vercel (projeto
# whatsapp-monitor-era) e consome a API por erareason.sobreip.com.br/wa-api.
# Aqui sobe so a API.

# ------------------------------------------------------------- 2. backup antes
CARIMBO=$(date +%Y%m%d-%H%M%S)
echo "▸ backup ($CARIMBO)…"
sr "set -e
    mkdir -p $DESTINO/backups
    [[ -f $DESTINO/server.mjs ]] && cp $DESTINO/server.mjs $DESTINO/backups/server-$CARIMBO.mjs
    true"

# ------------------------------------------------------------- 3. envia e sobe
echo "▸ enviando…"
scp -i "$CHAVE" -P "$PORTA_SSH" -q dist/server.mjs "$USUARIO@$HOST:$DESTINO/server.mjs.novo"

echo "▸ reiniciando…"
sr "set -e
    mv $DESTINO/server.mjs.novo $DESTINO/server.mjs
    systemctl restart $SERVICO
    sleep 4
    systemctl is-active --quiet $SERVICO"

# --------------------------------------------------- 4. confere e reverte se dá ruim
echo "▸ conferindo…"
if sr "curl -sf --max-time 10 http://127.0.0.1:3020/saude" >/dev/null 2>&1 \
   || sr "systemctl is-active --quiet $SERVICO"; then
  echo "✓ API no ar. Backup em $DESTINO/backups/server-$CARIMBO.mjs"
  echo "  painel: cd web && npx vercel --prod --yes"
else
  echo "✗ o serviço não voltou — revertendo."
  sr "cp $DESTINO/backups/server-$CARIMBO.mjs $DESTINO/server.mjs && systemctl restart $SERVICO"
  sr "journalctl -u $SERVICO -n 40 --no-pager"
  exit 1
fi
