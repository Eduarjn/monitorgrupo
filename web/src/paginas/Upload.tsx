import { useEffect, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { api, type ResultadoUpload } from '../lib/api.ts';
import { Aviso, Botao, Card, Titulo } from '../componentes/ui.tsx';

export default function Upload({ grupo }: { grupo: number }) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [progresso, setProgresso] = useState<string>('');
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);
  const [erro, setErro] = useState('');
  const [historico, setHistorico] = useState<Array<Record<string, unknown>>>([]);
  const input = useRef<HTMLInputElement>(null);

  const recarregar = () => api.uploads(grupo).then((r) => setHistorico(r.uploads)).catch(() => {});
  useEffect(() => { recarregar(); }, [grupo]);

  const enviar = async () => {
    if (!arquivo) return;
    setErro(''); setResultado(null);
    try {
      setProgresso('lendo o arquivo…');
      const r = await api.enviarExport(grupo, arquivo);
      setProgresso('');
      setResultado(r);
      recarregar();
    } catch (x) { setProgresso(''); setErro((x as Error).message); }
  };

  return (
    <div className="space-y-6">
      <Card>
        <Titulo sub="Exporte a conversa pelo app do WhatsApp (Exportar conversa › Sem mídia) e envie o .txt aqui.">
          Enviar export
        </Titulo>

        <div onClick={() => input.current?.click()}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => { e.preventDefault(); setArquivo(e.dataTransfer.files[0] ?? null); }}
             className="cursor-pointer rounded-xl border-2 border-dashed border-border p-8 text-center
                        transition hover:border-primary/60">
          <UploadCloud className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm">{arquivo ? arquivo.name : 'Clique ou arraste o arquivo .txt'}</p>
          {arquivo && <p className="mt-1 text-xs text-muted-foreground">{(arquivo.size / 1024).toFixed(0)} KB</p>}
          <input ref={input} type="file" accept=".txt,text/plain" className="hidden"
                 onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Botao onClick={enviar} disabled={!arquivo || !!progresso}>
            {progresso || 'Processar'}
          </Botao>
          {progresso && <span className="text-sm text-muted-foreground">{progresso}</span>}
        </div>

        {erro && <div className="mt-4"><Aviso tipo="erro">{erro}</Aviso></div>}

        {resultado && (
          <div className="mt-4">
            {resultado.duplicado ? (
              <Aviso>
                <b>Este export já tinha sido processado.</b> Nada foi duplicado — o arquivo é idêntico
                a um enviado anteriormente.
              </Aviso>
            ) : (
              <Aviso tipo="ok">
                <b>{resultado.mensagens_novas} mensagens novas</b> incorporadas.{' '}
                {resultado.mensagens_repetidas > 0 && (
                  <>{resultado.mensagens_repetidas} já existiam e foram ignoradas — é o esperado,
                     já que o WhatsApp exporta a conversa inteira toda vez.</>
                )}
                <div className="mt-2 text-xs text-muted-foreground">
                  {resultado.plataforma} · datas lidas como {resultado.formato_data}
                  {resultado.data_ambigua && ' (formato ambíguo — confira se as datas estão certas)'}
                  {' · '}{resultado.linhas_lidas} linhas
                </div>
                {resultado.avisos?.length ? (
                  <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
                    {resultado.avisos.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                ) : null}
              </Aviso>
            )}
          </div>
        )}
      </Card>

      <Card>
        <Titulo sub="Últimos arquivos processados neste grupo.">Histórico de coletas</Titulo>
        {historico.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum export enviado ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr><th className="py-2">Arquivo</th><th>Origem</th><th className="text-right">Novas</th>
                    <th className="text-right">Repetidas</th><th>Quando</th></tr>
              </thead>
              <tbody>
                {historico.map((u) => (
                  <tr key={String(u.id)} className="border-t border-border">
                    <td className="py-2">{String(u.arquivo_nome)}</td>
                    <td className="text-muted-foreground">{String(u.plataforma ?? '—')}</td>
                    <td className="text-right font-medium">{String(u.mensagens_novas ?? 0)}</td>
                    <td className="text-right text-muted-foreground">{String(u.mensagens_repetidas ?? 0)}</td>
                    <td className="text-muted-foreground">
                      {new Date(String(u.criado_em)).toLocaleString('pt-BR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
