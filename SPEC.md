# pi-provider-model-sync 仕様書

## 1. 目的

`pi-provider-model-sync` は、独自 URL を持つ Pi プロバイダの `/models` エンドポイントから利用可能なモデル一覧を取得し、Pi のモデルカタログ設定と結び付ける。

独自プロバイダの接続先・認証・API 形式は `models.json`、独自プロバイダごとのモデル一覧と上書き設定は `model-sources.json`、Pi のモデルカタログ設定は共通キャッシュで管理する。

## 2. 設定ファイルの場所

設定ファイルは次のディレクトリに配置する。`~/.pi/agent/` は Pi のグローバル設定ディレクトリ（`PI_CODING_AGENT_DIR` で変更可能）。

```text
~/.pi/agent/extensions/pi-provider-model-sync/
├── model-sources.json
└── cache/
    └── models.json
```

### 2.1 `models.json`

Pi 標準の `models.json` を使用する。

動的にモデル一覧を管理する独自プロバイダは、`models: []` で登録する。

```json
{
  "providers": {
    "test-provider1": {
      "baseUrl": "https://cf.llmhost.net/v1",
      "api": "openai-completions",
      "authHeader": true,
      "headers": {
        "content-type": "application/json"
      },
      "models": []
    }
  }
}
```

#### `models.json` の扱い

- `baseUrl`、`api`、`authHeader`、`headers` は独自プロバイダの接続設定として利用する。
- `models: []` は、パッケージがモデルを動的登録する対象プロバイダであることを示す。
- `models` を省略したプロバイダは、自動モデル一覧取得の対象にしない。
- パッケージは `models.json` 自体を書き換えない。
- `model-sources.json` のモデルを解決した後、同じプロバイダ名で `pi.registerProvider()` を呼び出す。

### 2.2 `model-sources.json`

独自プロバイダごとのモデル一覧、Pi モデル設定の取得元、上書き設定を管理する。

すべてのモデル定義はオブジェクト形式にする。文字列形式の省略記法は使用しない。

```json
{
  "providers": {
    "test-provider1": {
      "override": {
        "contextWindow": 131072,
        "compat": {
          "supportsReasoningEffort": false
        }
      },
      "models": [
        {
          "id": "gpt-5.6-terra",
          "config": "openai/gpt-5.6-sol",
          "override": {
            "maxTokens": 8192
          }
        },
        {
          "id": "gpt-5.6-luna",
          "config": ""
        }
      ]
    }
  }
}
```

#### モデル定義

| フィールド | 必須 | 説明 |
|---|---:|---|
| `id` | 必須 | 独自プロバイダの `/models` に返されたモデル ID |
| `config` | 任意 | Pi の取得元モデル。`provider/model` 形式 |
| `override` | 任意 | 対象モデルだけに適用する上書き |

`id` は独自プロバイダの `/models` レスポンスに含まれる ID と完全一致させる。通常起動では `/models` を再取得せず、既存の `model-sources.json` を信頼する。初回登録時と `/reload-provider` 実行時に取得した新規 ID は、その時点の `/models` レスポンスから登録する。

`config` は次のいずれも許可する。

- フィールド自体を省略する
- 空文字 `""` を指定する
- `provider/model` 形式を指定する

`config` が省略または空文字の場合、Pi のデフォルト値を使用する。これは、Pi の `models.json` にモデル ID だけを指定した場合と同じ扱いにする。

`config` が指定されている場合は、取得元モデルの能力情報を利用する。ただし、取得元モデルの ID と独自プロバイダの `id` は一致している必要はない。

例えば、独自プロバイダが `gpt-5.6-terra` を返す場合でも、次のように `gpt-5.6-sol` の設定を適用できる。

```json
{
  "id": "gpt-5.6-terra",
  "config": "openai/gpt-5.6-sol"
}
```

この場合の利用時モデル識別子は、独自プロバイダの ID に基づき次のようになる。

```text
test-provider1/gpt-5.6-terra
```

### 2.3 `cache/models.json`

`cache/models.json` は、Pi のモデルカタログを全プロバイダ分まとめて保存するキャッシュファイルとする。

キャッシュの構造は `https://pi.dev/api/models` のレスポンスに合わせる。

```json
{
  "openai": {
    "gpt-5.6-sol": {
      "id": "gpt-5.6-sol",
      "api": "openai-responses",
      "name": "GPT-5.6 Sol",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": {
        "input": 5,
        "output": 30,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      },
      "contextWindow": 272000,
      "maxTokens": 128000
    }
  },
  "anthropic": {
    "claude-sonnet-4-6": {}
  }
}
```

- Pi API から返されたモデルは、`config` で参照されているかどうかに関係なく保存する。
- 取得元 JSON の `baseUrl` は保存しない。
- 取得元 JSON の `api` も独自プロバイダへの適用には使用しない。
- 同じ Pi プロバイダを複数の独自プロバイダが参照する場合は、同じキャッシュを共有する。
- 独自プロバイダの `/models` から取得したモデル一覧は `cache/models.json` に保存しない。モデル一覧は `model-sources.json` に保存する。

## 3. 独自プロバイダのモデル一覧取得

### 3.1 エンドポイント

`models.json` の `baseUrl` に `/models` を付けた URL を使用する。

例:

```text
GET https://cf.llmhost.net/v1/models
```

認証やヘッダーは `models.json` のプロバイダ設定を利用する。

OpenAI 互換の次のレスポンス形式を基本とする。

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.6-sol"
    },
    {
      "id": "gpt-5.6-terra"
    }
  ]
}
```

`data[].id` を独自プロバイダのモデル ID として利用する。

### 3.2 初回登録

`models.json` に `models: []` の新しいプロバイダが追加され、`model-sources.json` に同じプロバイダの定義が存在しない場合、起動時に独自プロバイダの `/models` を取得する。

`data` が存在しない、または空配列の場合はエラー扱いにする。この場合、`model-sources.json` に対象プロバイダを登録・変更しない。

取得に成功した場合は、次の処理を行う。

1. Pi の全モデル API (`https://pi.dev/api/models`) を再取得する。
2. 取得結果を `cache/models.json` に保存する。
3. 独自プロバイダから取得した各モデルを、次の雛形として `model-sources.json` に登録する。

```json
{
  "id": "gpt-5.6-sol",
  "config": ""
}
```

初回登録後、通常の起動では独自プロバイダの `/models` と Pi の全モデル API を自動取得しない。

`model-sources.json` に対象プロバイダの定義が存在することを、初回登録済みの判定に使用する。

### 3.3 自動更新を行わない範囲

通常の起動時には、次の情報を自動更新しない。

- 既存の独自プロバイダのモデル一覧
- 既存モデルの `id`
- 既存モデルの `config`
- 既存モデルの `override`
- `cache/models.json` に保存された Pi モデル設定

独自プロバイダのモデル一覧は `model-sources.json` を正とする。

ユーザーが設定した `config` や `override` は、起動時の自動処理で変更しない。

新しい独自プロバイダの追加時と `/reload-provider` の実行時だけ、Pi の全モデル API を再取得して `cache/models.json` を更新する。

## 4. Pi モデル設定の取得

### 4.1 全モデル一覧

Pi のモデルカタログは、次のエンドポイントから全プロバイダ分を取得する。プロバイダ別エンドポイントは使用しない。

```text
GET https://pi.dev/api/models
```

取得した全プロバイダ・全モデルの設定は、参照対象だけに限定せず、すべて `cache/models.json` に保存する。

新しい独自プロバイダの初回登録時と `/reload-provider` 実行時だけ再取得する。

### 4.2 取得済み設定のキャッシュ

`config` の取得元を分解し、`cache/models.json` から設定を解決する。

例:

```text
config: openai/gpt-5.6-sol
cache:  cache/models.json → openai → gpt-5.6-sol
```

通常の起動では Pi API を再取得しない。キャッシュに対象モデルが存在しない場合は、`/reload-provider` を促すエラーとする。

`config` が省略または空文字の場合は、通常のモデル解決で Pi API を参照しない。ただし、初回登録時または `/reload-provider` 実行時の全モデル API 取得では、参照されていないモデルも含めてキャッシュする。

Pi API の取得に失敗した場合は、既存の `cache/models.json` を保持する。キャッシュが存在しないモデルを利用する場合は、モデル解決時にエラーとする。

## 5. 取得元設定の扱い

取得したモデル設定から、独自プロバイダの接続先と競合する項目は採用しない。

- `baseUrl`: 最終モデル設定から除去する
- `api`: 最終モデル設定から除去する
- 取得元のプロバイダ識別情報: 独自プロバイダの登録名を使用する

`name`、`reasoning`、`input`、`cost`、`contextWindow`、`maxTokens`、`thinkingLevelMap`、`compat` などのモデル能力情報は取得元から利用する。

独自プロバイダの `api` と `baseUrl` は `models.json` の設定をデフォルトとして使用する。

ただし、`override` に `api` または `baseUrl` が明示されている場合は、明示された値を使用する。

`config` が省略または空文字の場合は Pi API から設定を取得せず、モデル ID だけを指定した場合と同じ Pi のデフォルト値を使用する。

## 6. 上書き仕様

### 6.1 適用順

モデルの最終設定は、次の順序で作成する。

```text
取得元モデル設定、または Pi のデフォルトモデル定義
  ↓
models.json のプロバイダ設定
  ↓
providers.<providerName>.override
  ↓
providers.<providerName>.models[].override
```

後に適用される設定が優先される。

### 6.2 プロバイダ単位の上書き

```json
{
  "providers": {
    "test-provider1": {
      "override": {
        "contextWindow": 131072,
        "maxTokens": 16384
      },
      "models": [
        {
          "id": "gpt-5.6-terra",
          "config": "openai/gpt-5.6-sol"
        },
        {
          "id": "gpt-5.6-luna",
          "config": "anthropic/claude-sonnet-4-6"
        }
      ]
    }
  }
}
```

`providers.test-provider1.override` は、`test-provider1` に登録されるすべてのモデルへ適用される。

### 6.3 モデル単位の上書き

```json
{
  "id": "gpt-5.6-terra",
  "config": "openai/gpt-5.6-sol",
  "override": {
    "maxTokens": 8192
  }
}
```

`models[].override` は、そのモデルだけに適用される。

プロバイダ単位の `override` と同じ項目を指定した場合は、モデル単位の `override` が優先される。

### 6.4 マージ方式

- ネストしたオブジェクトは再帰的にマージする。
- 配列はマージせず、後から指定された配列で置換する。
- モデルの `id` と `config` は構造情報のため、`override` では変更できない。
- `override` による明示的な値は、取得元設定の値より優先する。

## 7. 起動時の処理

1. Pi が通常どおり `models.json` を読み込む。
2. パッケージが `models: []` の独自プロバイダを検出する。
3. `model-sources.json` に対象独自プロバイダが存在しない場合、独自プロバイダの `/models` を取得する。
4. `/models` の `data` が空の場合はエラーにして、`model-sources.json` を変更せず終了する。
5. 初回登録の場合、Pi の全モデル API (`https://pi.dev/api/models`) を再取得する。
6. 初回取得した独自プロバイダのモデル一覧を `{ "id": "...", "config": "" }` の雛形として `model-sources.json` に保存する。
7. Pi API の取得結果を `baseUrl` を除外して `cache/models.json` に保存する。
8. `model-sources.json` に存在する各モデル定義を読み込む。
9. `config` が空でないモデルについて、`cache/models.json` の取得元プロバイダとモデル ID を確認する。
10. `config` のモデル設定を解決する。
11. プロバイダ単位の `override` を適用する。
12. モデル単位の `override` を適用する。
13. 対象独自プロバイダ名で `pi.registerProvider()` を呼び出す。
14. Pi の `/model`、`--list-models`、モデル指定から利用できる状態にする。

## 8. `/reload-provider` コマンド

次のコマンドで、指定した独自プロバイダの `/models` と Pi の全モデル API を明示的に再取得する。

```text
/reload-provider <provider>
```

### 8.1 更新処理

1. `models.json` から指定独自プロバイダの `baseUrl` と認証設定を取得する。
2. `<baseUrl>/models` を取得する。
3. `/models` の `data` が空の場合はエラーにし、既存の `model-sources.json` と `cache/models.json` を変更しない。
4. Pi の全モデル API (`https://pi.dev/api/models`) を再取得する。
5. Pi API の取得結果を `baseUrl` を除外して `cache/models.json` に保存する。
6. 現在の `model-sources.json` のモデル一覧と比較する。
7. API に存在する新規 ID は、次の雛形で `model-sources.json` に追加する。

```json
{
  "id": "new-model",
  "config": ""
}
```

8. 既存 ID のモデル定義は変更しない。
9. 既存 ID が参照する `config` と `override` は変更しない。
10. API のレスポンスに存在しなくなった ID は削除せず、`model-sources.json` の既存定義をそのまま残す。
11. 更新後のモデル一覧を `pi.registerProvider()` へ反映する。

### 8.2 更新対象外

`/reload-provider` は、既存モデルの `config` と `override` を変更しない。

API のレスポンスに存在しなくなった既存 ID も削除しない。

Pi の全モデル API は `/reload-provider` の実行時に再取得するため、`cache/models.json` のモデル設定は更新される。ただし、独自プロバイダへ登録済みのモデル定義に対する `config` や `override` の変更は行わない。

## 9. 登録例

`models.json`:

```json
{
  "providers": {
    "test-provider1": {
      "baseUrl": "https://cf.llmhost.net/v1",
      "api": "openai-completions",
      "authHeader": true,
      "headers": {
        "content-type": "application/json"
      },
      "models": []
    }
  }
}
```

初回起動後の `model-sources.json`:

```json
{
  "providers": {
    "test-provider1": {
      "models": [
        {
          "id": "gpt-5.6-sol",
          "config": ""
        },
        {
          "id": "gpt-5.6-terra",
          "config": ""
        }
      ]
    }
  }
}
```

設定後の `model-sources.json`:

```json
{
  "providers": {
    "test-provider1": {
      "override": {
        "compat": {
          "supportsDeveloperRole": false
        }
      },
      "models": [
        {
          "id": "gpt-5.6-terra",
          "config": "openai/gpt-5.6-sol",
          "override": {
            "maxTokens": 8192
          }
        },
        {
          "id": "gpt-5.6-luna",
          "config": "anthropic/claude-sonnet-4-6"
        }
      ]
    }
  }
}
```

利用時のモデル識別子:

```text
test-provider1/gpt-5.6-terra
test-provider1/gpt-5.6-luna
```

キャッシュ例 `cache/models.json`:

```json
{
  "openai": {
    "gpt-5.6-sol": {
      "id": "gpt-5.6-sol",
      "api": "openai-responses",
      "name": "GPT-5.6 Sol",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 272000,
      "maxTokens": 128000
    }
  },
  "anthropic": {
    "claude-sonnet-4-6": {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  }
}
```

## 10. エラー処理

次の場合は、対象プロバイダとモデルを含む明確なエラーを表示する。

- `id` がない
- 独自プロバイダの `/models` が空のモデル一覧を返した
- `config` が `provider/model` 形式でない
- 取得元 Pi プロバイダが存在しない
- 指定した Pi モデルが取得元に存在しない
- 独自プロバイダの `/models` 取得に失敗した
- Pi モデル設定の取得に失敗した
- `override` に変更不可の `id` または `config` が含まれている
- `/reload-provider` の対象プロバイダが `models.json` に存在しない

独自プロバイダの `/models` 初回取得に失敗した場合、既存の `model-sources.json` があれば保存済みのモデル一覧を利用する。初回で `model-sources.json` もない場合は、対象プロバイダにモデルを登録せずエラーを通知する。

独自プロバイダの `/models` が空の場合はエラーとし、`model-sources.json` を新規作成・変更しない。

Pi API の取得に失敗した場合、既存の `cache/models.json` があればそれを保持して利用する。対象モデルの設定がキャッシュにない場合は、モデル解決時にエラーとする。

## 11. 設計上の方針

- パッケージ名は `pi-provider-model-sync` とする。
- `models.json` は独自プロバイダの接続設定に限定する。
- `model-sources.json` は独自プロバイダごとのモデル一覧、Pi カタログの参照、上書き設定を管理する。
- `cache/models.json` は Pi のモデルカタログ全体をプロバイダ単位で管理する。
- 独自プロバイダごとのキャッシュファイルは作成しない。
- `models.json` を動的に書き換えない。
- 初回起動後、独自プロバイダのモデル一覧は自動更新しない。
- モデル一覧の更新は `/reload-provider <provider>` によって明示的に行う。
- Pi 本体を変更せず、Pi package の Extension として実装する。
- 取得元の `baseUrl` と `api` を独自プロバイダへ引き継がない。
