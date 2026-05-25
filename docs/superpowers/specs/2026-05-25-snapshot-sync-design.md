# Snapshot Sync para ERPs sem Cursor Confiavel

## Contexto

O conector hoje sincroniza produtos com uma query incremental baseada em `cursorField` e `cursorType`. Esse modelo funciona quando o ERP atualiza um campo como `updated_at`, sequencia incremental ou equivalente sempre que qualquer dado sincronizado muda.

Alguns ERPs nao oferecem um campo confiavel de atualizacao. Nesses casos, uma alteracao de preco pode nao mover o cursor e, portanto, nao entrar no proximo `product.batch`. Para manter o agente agnostico e confiavel, o conector precisa de um modo que detecte mudancas pelo estado observado do produto, nao apenas por metadados de atualizacao do ERP.

## Objetivo

Adicionar um modo de sincronizacao `snapshot` para bases com ate 10 mil produtos, capaz de refletir produtos novos e alteracoes em campos sincronizados no proximo ciclo normal de polling, mesmo quando o ERP nao possui `updated_at` confiavel.

## Fora de Escopo

- Detectar remocoes de produtos como inativacao automatica.
- Substituir o modo incremental existente.
- Garantir suporte inicial para bases acima de 10 mil produtos.
- Criar triggers, tabelas auxiliares ou qualquer alteracao no banco do ERP.

## Modos de Sincronizacao

O mapping passa a declarar o modo de sincronizacao:

```ts
syncMode: "incremental" | "snapshot"
```

### Incremental

Mantem o comportamento atual:

- usa `incrementalQuery`;
- usa `cursorField` e `cursorType`;
- envia linhas retornadas pela query;
- avanca `lastAckedCursor` somente apos `batch.ack` aceito.

### Snapshot

Novo modo para ERPs sem cursor confiavel:

- usa uma query de listagem completa, ordenada e paginada;
- le todos os produtos a cada ciclo de polling;
- aplica o mapping de campos;
- calcula um hash deterministico dos campos sincronizados;
- compara com um indice local persistido por `sourceProductCode`;
- envia apenas produtos novos ou com hash alterado.

## Contrato de Mapping

Campos propostos para `snapshot`:

```ts
interface SnapshotMappingConfig {
  syncMode: "snapshot";
  snapshotQuery: string;
  snapshotPageSize: number;
  batchSize: number;
  fields: ProductFieldMappings;
  selectedProductTable?: string;
}
```

`snapshotQuery` deve aceitar parametros de paginacao e retornar uma ordenacao estavel. Exemplo MySQL:

```sql
select * from products order by product_id limit ? offset ?
```

Exemplo Firebird:

```sql
select * from products order by product_id rows ? to ?
```

A forma exata dos parametros pode seguir a abstracao dos adapters, mas a regra do contrato e que a leitura seja completa, ordenada e repetivel.

## Estado Local

O estado persistido do conector passa a suportar um indice snapshot:

```ts
snapshotState: {
  fieldsSignature: string;
  products: {
    [sourceProductCode: string]: {
      hash: string;
      lastSeenAt: string;
      lastConfirmedAt: string;
    };
  };
}
```

`fieldsSignature` representa a configuracao que influencia o hash, incluindo tabela, query, campos mapeados e versao relevante do contrato. Se a assinatura mudar, o indice anterior nao deve ser reutilizado.

O indice snapshot nao substitui o estado incremental. Cada modo usa apenas a parte do estado que lhe pertence.

## Fluxo Ponta a Ponta

1. O painel ou wizard define `syncMode`.
2. Se o ERP tem campo confiavel de atualizacao, usa `incremental`.
3. Se o ERP nao tem campo confiavel, usa `snapshot`.
4. No primeiro ciclo snapshot, o agente le todos os produtos em paginas.
5. Cada linha e mapeada para o formato de produto.
6. O agente calcula o hash dos campos sincronizados.
7. Como o indice local ainda nao existe, produtos validos entram como novos.
8. O agente envia um `product.batch` respeitando `batchSize`.
9. Ao receber `batch.ack` aceito, grava os hashes confirmados no indice local.
10. Se o ACK falhar ou pedir retry, o indice local nao e atualizado.
11. Nos ciclos seguintes, o agente repete a varredura completa.
12. Produto com hash igual e ignorado.
13. Produto novo ou com hash diferente entra no proximo batch.
14. Produto que desapareceu da query e ignorado.

## Garantia de Consistencia

A garantia principal do modo snapshot e:

> Se um produto presente na query tiver qualquer campo sincronizado alterado, essa alteracao sera detectada no proximo ciclo normal de polling e enviada em batch, desde que a leitura do ERP conclua com sucesso e o batch anterior tenha sido confirmado ou esteja livre para envio.

A atualizacao do indice local ocorre somente apos ACK aceito. Isso evita marcar como sincronizada uma alteracao que a central ainda nao confirmou.

## Hash de Produto

O hash deve ser calculado depois da normalizacao do mapping, usando apenas campos que representam o contrato enviado para a central:

- `sourceProductCode`;
- `name`;
- `barcode`;
- `price`;
- `stock`;
- `active`;
- `sourceUpdatedAt`, se presente e relevante para o payload.

O algoritmo deve serializar os campos de forma estavel antes de aplicar hash. Campos ausentes e valores nulos precisam ter representacao consistente para evitar falsos positivos.

## Batches Pendentes

O modo snapshot precisa lidar com mais mudancas detectadas do que o `batchSize` permite enviar em uma unica mensagem.

Regra proposta:

- durante a varredura, o agente acumula mudancas detectadas;
- envia ate `batchSize`;
- persiste o restante como pendente no estado local, para sobreviver a restart;
- nao envia outro batch enquanto houver batch aguardando ACK;
- apos ACK aceito, atualiza o indice dos produtos confirmados e continua enviando pendentes antes de iniciar uma nova varredura completa.

Essa regra preserva o mesmo modelo operacional atual: um batch em voo por vez.

## Mudanca de Mapping

O indice snapshot deve ser invalidado quando qualquer item abaixo mudar:

- `syncMode`;
- `selectedProductTable`;
- `snapshotQuery`;
- `fields.sourceProductCode`;
- qualquer campo sincronizado usado no hash;
- regra de normalizacao ou versao de assinatura.

Ao invalidar o indice, a proxima varredura trata os produtos presentes como novos. Essa regra evita reutilizar hashes calculados com contrato antigo e privilegia confiabilidade sobre economia de trafego.

## Erros e Observabilidade

Eventos esperados:

- `snapshot.scan.started`;
- `snapshot.scan.completed`;
- `snapshot.scan.failed`;
- `snapshot.diff.completed`;
- `snapshot.batch.prepared`;
- `snapshot.index.updated`;
- `snapshot.index.invalidated`.

Logs devem incluir contagens:

- produtos lidos;
- produtos validos;
- produtos rejeitados;
- produtos novos;
- produtos alterados;
- produtos ignorados por hash igual;
- produtos pendentes para proximos batches.

## Testes Esperados

Unitarios:

- valida mapping `snapshot` com `snapshotQuery` e `snapshotPageSize`;
- calcula hash estavel para produto normalizado;
- detecta produto novo;
- detecta alteracao de preco sem `updated_at`;
- ignora produto com hash igual;
- ignora produto removido da query;
- invalida indice quando `fieldsSignature` muda;
- nao atualiza indice quando ACK falha.

Integracao:

- executa primeiro snapshot e envia produtos novos;
- apos ACK, persiste hashes confirmados;
- altera apenas `price` no fixture sem alterar cursor e envia no proximo polling;
- respeita `batchSize` com mais mudancas do que cabem em um batch;
- mantem um batch em voo por vez;
- preserva comportamento incremental existente.

## Decisao

Implementar `snapshot` como fallback confiavel para ERPs sem campo confiavel de atualizacao, mantendo `incremental` como modo eficiente para ERPs que possuem cursor correto. Para o limite assumido de ate 10 mil produtos, a varredura completa paginada a cada ciclo normal de polling e aceitavel e entrega a confiabilidade exigida.
