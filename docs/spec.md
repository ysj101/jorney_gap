# JourneyGap — MVP実装仕様（公開OSS・独立プロダクト）

| 項目 | 内容 |
| --- | --- |
| ドキュメント | `spec.md` |
| バージョン | `1.0.0-draft` |
| 作成日 | 2026-11-13 |
| ステータス | 実装仕様。記載のパッケージ・コマンドは未実装／未公開 |
| 対象 | 静的サイトを含むブラウザWebアプリ |
| ライセンス | Apache-2.0（採用案。公開前にライセンス・依存ライセンスを確認） |
| 技術 | TypeScript / OpenTelemetry / OTLP/HTTP / Node.js / SQLite |

## 0. 実装上の決定事項

**JourneyGapは、アプリケーション固有の「目的達成までのステップ」をOpenTelemetryで観測し、未到達・停滞の兆候を根拠付きで報告する独立したOSSである。** ヒートマップやセッション録画ではなく、アプリが定義したジャーニーの進行に特化する。

- **送信先にベンダーロックインしない。** ブラウザからの出力は標準 **OTLP/HTTP JSON（`POST /v1/traces`）** を使用する。OpenTelemetry Collector、JaegerのOTLP受信口、任意の互換サービス等へ接続可能。特定のSaaSや独自受信プロトコルは必須にしない。
- **分析に特定の観測バックエンドのクエリAPIを必要としない。** リファレンス用の軽量なJourneyGap RelayがOTLPを受け、JourneyGapイベントだけSQLiteに保存して分析する。任意のOTLPアップストリームへの転送も可能。ファイルに書き出したOTLP JSONのオフライン分析にも対応する。
- **ワンコマンド導入。** 対応するVite + TypeScriptのWebアプリに `npx @journeygap/cli init --endpoint <PUBLIC_OTLP_URL>` でブートストラップを追加する（UI・状態管理は改変しない）。`uninstall` で元に戻せる。CLIの対象拡張は後続バージョンで対応する。
- **取得できる情報には境界がある。** 自動計測はページ遷移・明示的なイベントまで。アプリ独自の達成状態はアプリが公開API `trackStep()` を呼ぶ必要がある。CLIによる導入だけで任意のアプリの内部状態を推測できるとは主張しない。
- **同意前には何も送らない。** ブラウザの既定はオプトイン。SDK内蔵の小さな同意UIを標準提供し、既存の同意管理との置き換えも可能にする。
- **フェイルオープン。** 計測の通信失敗・ロード失敗・分析の障害がホストアプリの描画、入力、保存、ナビゲーションに影響しない。
- **余計な機能は作らない。** MVPにLLM、セッションリプレイ、全クリック取得、アカウント登録、Grafanaプラグイン、マルチテナント管理画面、UI自動修正を含めない。

### 0.1 受入定義（1文）

独立したサンプルViteアプリに1コマンドで導入し、同意後に2つのジャーニーを計測でき、OTLP互換受信機へ送信し、失敗があってもアプリを妨げず、JourneyGapだけで到達率と未到達の根拠をレポートできること。

## 1. プロダクトの解決する問題と非目標

### 1.1 解決する問題

一般的な行動分析は「どのページで離脱したか」は把握できても、あるWebアプリにとって意味のある「着手 → 必要な情報の確認 → 操作の完了」までが正しく進んだかは、明示的な定義が必要である。JourneyGapは開発者が少数のステップを宣言し、実行時の状態変化を計測して、**未到達地点・観測された滞在時間・低サンプルの不確実性**を示す。

### 1.2 想定利用者

小規模なWebアプリ、学習ツール、フォーム、対話型コンテンツを開発する個人・小規模チーム。対象アプリは静的ホスティングでもよく、JourneyGap本体とアプリは別々のリポジトリとして管理できる。

### 1.3 非目標

- クリック録画、マウス追跡、セッションリプレイ、ヒートマップ、入力内容の保存。
- 利用者の実名、アカウントID、メール、IPアドレス、自由記述、回答本文の収集。
- 閲覧者の心理状態、楽しさ、能力、意図を自動推定・断定すること。
- 任意のアプリから自動的に内部のビジネス成果を推測すること。
- 分析結果からのコード自動変更・GitHub Issue自動作成。
- すべてのWebフレームワークへのワンコマンド対応（MVPはVite + TypeScriptのみ）。
- 特定の観測SaaSのAPI、専用SDK、独自イベント転送形式への必須依存。

## 2. アーキテクチャと責務

```text
                    任意のVite + TypeScript Webアプリ
                        └── @journeygap/web
                            ├── 同意管理・匿名セッションID
                            ├── navigation / trackStep API
                            ├── allowlist / サニタイズ / batch
                            └── OTLP/HTTP JSON Exporter
                                       │ HTTPS (browser-safe, no secret)
                                       ▼
           ┌────────────────────────────────────────────┐
           │ 任意のOTLP/HTTP受信先                       │
           │   A. JourneyGap Relay (MVP参照実装)         │
           │      ├── 認可・レート制限・CORS             │
           │      ├── OTLPの検証・抽出                  │
           │      ├── SQLite（イベントと集計）           │
           │      └── 任意の上流OTLP/HTTPへ転送         │
           │   B. OpenTelemetry Collector / その他      │
           │      └── 必要ならOTLP JSONをファイル出力   │
           └────────────────────────────────────────────┘
                         │              │
                SQLite/OTLP JSON       任意のベンダー
                         ▼              ▼
                @journeygap/analyzer   Grafana Cloud, Jaeger等
                         │
                         ▼
                 CLI report (根拠付き)
```

**重要な区別:** OTLPはテレメトリーを「送る」規格であり、任意のバックエンドからデータを「検索する」共通クエリAPIではない。そのため分析エンジンはSQLiteまたはOTLP JSON入力を標準とし、特定ベンダーのクエリAPIを前提としない。

### 2.1 MVPのパッケージ

| パッケージ | 主な責務 | 外部依存 |
| --- | --- | --- |
| `@journeygap/web` | ブラウザ計測・同意・OTLP Trace出力 | OpenTelemetry JS API/SDK/HTTP exporter |
| `@journeygap/core` | 公開型、イベントスキーマ検証、ジャーニー判定 | TypeScript、バリデーションライブラリ |
| `@journeygap/relay` | OTLP/HTTP JSON受信、SQLite保存、任意の上流転送、管理API | Node.js、SQLite |
| `@journeygap/cli` | init/uninstall/doctor/report/import | Node.js、package managerの検出 |
| `examples/vite-basic` | 完全に独立したデモアプリ、E2E・受入用 | Vite + TypeScript |

`@journeygap/analyzer` は初期MVPでは `core` の分析モジュールとして実装し、パッケージを増やさない。Reactへの依存は`web`に持ち込まず、Reactプロジェクトは通常のTypeScript APIを利用する。

### 2.2 リポジトリ構成

```text
journeygap/
├── spec.md
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── CHANGELOG.md
├── .github/workflows/{ci,release}.yml
├── .github/ISSUE_TEMPLATE/
├── .gitignore
├── .env.example
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── packages/
│   ├── web/src/{index,consent,navigation,otlp,privacy}.ts
│   ├── core/src/{schema,journey,analyze,types}.ts
│   ├── relay/src/{server,ingest,storage,forward,admin}.ts
│   └── cli/src/{index,init,uninstall,doctor,report,import}.ts
├── examples/vite-basic/
├── deploy/{docker-compose.yml,collector.example.yaml}
├── docs/{configuration,event-schema,privacy,deploy,architecture}.md
└── tests/{e2e,fixtures}/
```

Node.js 24 LTS以上、TypeScript、pnpm workspace、Vitest、Playwrightを基準にする。公開前に採用したOpenTelemetry JSの対応バージョンと依存関係を固定してCIで検証する。

## 3. 観測モデル（OTelとJourneyGapの境界）

### 3.1 使用するシグナル

MVPでは**Tracesのみ必須**とする。アプリ操作の各ステップを完結した短いSpanとして記録し、1セッションを何十分もの長命Spanにしない。セッション横断の相関は明示的なIDで表現する。Metrics/Logs、Faro、Session Replayは必須にしない。

**理由:** OpenTelemetry JSのTracesは安定したAPIを提供する一方、JS Logsは開発段階である。将来的にLogsへ移しても、公開イベントスキーマは変更しない。短いSpanは「アプリ内の意味ある操作の発生」を示すものであり、ユーザー体験全体の因果関係がTraceだけで完全に表現できるという意味ではない。

### 3.2 OTLPの形式

- Web SDKから `POST https://<endpoint>/v1/traces` に **OTLP/HTTP JSON** を送る（`Content-Type: application/json`）。
- OpenTelemetry JSの `@opentelemetry/exporter-trace-otlp-http` を使用し、独自のJSONをOTLPと呼ばない。
- `resource` 属性に `service.name`, `service.version`, `deployment.environment.name` （取得可能な場合）を記録。
- 各Span名は `journeygap.navigation` / `journeygap.step` / `journeygap.error`。未定義のSpan名を自動生成しない。
- Span属性は下記の`journeygap.*`を採用。大きな情報、ユーザー入力、URLクエリ、スタックトレースは送らない。
- Spanは終了させてバッチ送信。全体のジャーニーを単一のTrace IDでつながない。バックエンドのサンプリングで欠落し得ることをレポートに表示する。

### 3.3 公開属性スキーマ `journeygap.schema_version = 1`

| 属性 | 型 | 必須 | 内容 |
| --- | --- | --- | --- |
| `journeygap.schema_version` | integer | Yes | `1` |
| `journeygap.event_id` | string(UUIDv4) | Yes | 重複除去用、1イベントごとに生成 |
| `journeygap.session_id` | string(UUIDv4) | Yes | 同意後、タブ単位の匿名ID |
| `journeygap.instance_id` | string(UUIDv4) | stepのみ | 1つのジャーニー試行の識別子 |
| `journeygap.event_type` | enum | Yes | `navigation` / `step` / `error` |
| `journeygap.journey_id` | string | stepのみ | 定義されたジャーニーID |
| `journeygap.step_id` | string | stepのみ | 定義されたステップID |
| `journeygap.route_id` | string | navigationのみ | 許可されたルートテンプレート名 |
| `journeygap.app_version` | string | No | アプリのリリース識別子 |
| `journeygap.error_kind` | enum | errorのみ | `render` / `network` / `unknown` |

制約: IDは`^[a-z][a-z0-9._-]{0,63}$`。`app_version`は64文字以下。イベント属性の追加は、アプリごとに設定した**明示的な許可リスト**に限る（型は`string | number | boolean`、キー64文字以下、文字列100文字以下、総属性数10個以下）。値がメールアドレス・URL・長文・機密情報に見える場合は送らず、許可リストがあっても入力本文は記録しない。カスタム属性キーは`app.`で開始する。低カーディナリティのみ許可する。

### 3.4 セッションとイベント重複

- 同意後に`crypto.randomUUID()`で匿名セッションIDを作る。セッションIDだけを`sessionStorage`に保存し、ブラウザタブを閉じると失効する。localStorageに保存するのは同意状態のみ。
- 目的達成の試行開始時にinstance IDを作り、同じタブでの次の試行は新IDにする。
- アプリのURL・ブラウザの完全なUser Agent・Cookie・IP・ユーザーIDをイベントに含めない。
- `event_id`で受信側が冪等化する。リロードやReact StrictModeに起因する重複は送信側でも可能な限り抑止する。セッションIDは一定期間の仮名識別子であり、絶対的な匿名化を保証するものではない。
- クライアントの時計は信用し切らない。サーバーは受信時刻を別管理する。大きな時計ずれは集計から除外する。

## 4. 公開Web SDK API

### 4.1 型と最小API

```ts
export type JourneyStep = { id: string; terminal?: boolean };
export type JourneyDefinition = {
  id: string;
  steps: JourneyStep[]; // MVPは順序付き・一方向のステップ
  timeoutMinutes: number; // 1..1440、既定30
};

export type JourneyGapConfig = {
  schemaVersion: 1;
  enabled: boolean;
  serviceName: string;
  serviceVersion?: string;
  otlpTracesEndpoint: string; // /v1/traces まで含む完全なURL
  consent: { mode: 'opt-in'; ui: 'compact' | 'external' };
  routes?: Array<{ id: string; pattern: string }>;
  journeys: JourneyDefinition[];
  attributesAllowlist?: string[];
};

export type Scalar = string | number | boolean;
export type TrackAttributes = Record<string, Scalar>;
export type JourneyGapClient = {
  trackStep(journeyId: string, stepId: string, attrs?: TrackAttributes): void;
  trackError(kind: 'render' | 'network' | 'unknown'): void;
  setConsent(value: boolean): void;
  getConsent(): boolean;
  shutdown(): Promise<void>;
};

export function initJourneyGap(config: JourneyGapConfig): JourneyGapClient;
// アプリ内の任意の観測アダプターから利用する。未初期化時はno-op。
export function getJourneyGapClient(): JourneyGapClient | null;
export function trackStep(journeyId: string, stepId: string, attrs?: TrackAttributes): void;
```

- `initJourneyGap` は同一タブで冪等。`getJourneyGapClient`はSDKが初期化済みの場合に同じclientを返し、`trackStep`は未初期化/無効化/未同意時に何もしない。起動時に consent=false ならOTel SDK/Exporterを生成しない。`setConsent(false)`で送信を即座に停止し、バッファを破棄し、以後はイベントを生成しない（同意状態を永続化）。
- `consent.ui='compact'` はDOMベースのアクセシブルな小型同意UIをSDKが表示。`external`は既存同意管理との統合用で、外部コードが`setConsent(true)`を呼ぶまでは送信しない。
- 監視イベントは全て例外を内部で捕捉する。ログ出力も既定OFF、診断モードでのみ簡略メッセージを表示。
- `trackStep` は設定済みのjourney ID・step IDのみ受け付け、存在しない組み合わせは送信しない。
- 呼び出しは同期・非ブロッキング。イベント送信はタイムアウト付きのバッチで非同期に行う。
- `routes` は正規表現文字列ではなく、`/items/:id`等の単純なパターン形式を採用。クエリ文字列・ハッシュ中の識別子・自由入力は送信しない。パターンに一致しないルートは`unknown`へ正規化。
- 初期化時に`hashchange`, `popstate`, History APIによる遷移を検知し、同じroute IDの連続発行を抑止。history patchは解除可能で、他SDKと競合した場合はパッチせず`hashchange/popstate`へフォールバック。
- `shutdown`はイベントリスナ・同意UI・SDK資源を解放する。他のOpenTelemetry SDKのグローバルTracerProviderを強制上書きせず、JourneyGap専用providerを利用する。

### 4.2 SDK利用例

```ts
import { initJourneyGap } from '@journeygap/web';

const journeyGap = initJourneyGap({
  schemaVersion: 1,
  enabled: true,
  serviceName: 'sample-web',
  otlpTracesEndpoint: 'https://ingest.example.org/v1/traces',
  consent: { mode: 'opt-in', ui: 'compact' },
  routes: [{ id: 'welcome', pattern: '/' }, { id: 'flow', pattern: '/flow' }],
  journeys: [{
    id: 'first-task',
    steps: [
      { id: 'started' },
      { id: 'reviewed' },
      { id: 'completed', terminal: true },
    ],
    timeoutMinutes: 30,
  }],
});

// アプリが意味を理解している時点で、必要なイベントだけ送る。
journeyGap.trackStep('first-task', 'started');
journeyGap.trackStep('first-task', 'reviewed');
journeyGap.trackStep('first-task', 'completed');
```

同意しない場合はネットワーク送信0件。機能導入なしでもアプリ本体は動作する。

### 4.3 設定ファイル

`journeygap.config.json` を生成する。JSON Schemaはリポジトリ内 `packages/core/schema/journeygap.schema.json` に同梱し、CIで型との同期を確認。公開npmパッケージに含む。

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "serviceName": "sample-web",
  "otlpTracesEndpoint": "https://ingest.example.org/v1/traces",
  "consent": { "mode": "opt-in", "ui": "compact" },
  "routes": [{ "id": "welcome", "pattern": "/" }],
  "journeys": [{
    "id": "first-task",
    "steps": [
      { "id": "started" },
      { "id": "reviewed" },
      { "id": "completed", "terminal": true }
    ],
    "timeoutMinutes": 30
  }]
}
```

URLは公開値として扱うが、`Bearer`や`Basic`など秘密認証ヘッダー、トークン、パスワードを設定ファイル・ブラウザBundleへ記述してはならない。ドキュメントにも実トークンを掲載しない。

## 5. 分析エンジンの仕様

### 5.1 ジャーニー定義・到達判定

- 定義は一次元の順序付きステップ（MVPは複雑なDAGを扱わない）。最終ステップに`terminal: true`を必須とする。最低2ステップ、最大20ステップ。
- 最初のステップを受けた時点で試行開始。以降は指定された順序どおりのステップだけを到達と見なす。過去ステップの再送はイベントとして保存しても進行段階を戻さない。
- 順序を飛ばしたイベントは`out_of_order`として記録し、後のステップを暗黙に成功扱いしない。
- 同一タブで複数のjourney IDを同時に観測できる。同じjourney IDで最初のステップが再度発生したら、未完了の旧試行を`superseded`（別の試行に切替）として閉じ、新しいinstance IDを生成する。完了後の再着手でも新IDを生成する。`superseded`は必ずしも離脱を意味しない。
- タイムアウトした試行は`not_observed_after_timeout`。**「離脱した」「分からなかった」と断定しない**。ブラウザ閉鎖・通信断・同意撤回・サンプリングによる欠落と区別できないため。
- タイムアウト前、サンプル不足、イベント欠損は`insufficient_evidence`とし、改善提案の確信度を下げる。

### 5.2 `analyze()`入出力

```ts
export type JourneyEvent = {
  schemaVersion: 1;
  eventId: string;
  timestampMs: number;
  receivedAtMs?: number;
  sessionId: string;
  instanceId: string;
  journeyId: string;
  stepId: string;
};

export type JourneyReport = {
  journeyId: string;
  window: { fromMs: number; toMs: number };
  observedStarts: number;
  observedCompletions: number;
  stepCounts: Array<{ stepId: string; reached: number; medianMsFromStart: number | null }>;
  incompleteAfterTimeout: number;
  supersededAttempts: number;
  outOfOrderEvents: number;
  sampleStatus: 'sufficient' | 'insufficient';
  findings: Array<{
    kind: 'large_drop' | 'slow_step' | 'out_of_order' | 'insufficient_data';
    stepId?: string;
    evidence: Record<string, number | string>;
    interpretation: string;
    confidence: 'low' | 'medium';
  }>;
};

export function analyze(events: JourneyEvent[], definition: JourneyDefinition, nowMs: number): JourneyReport;
```

- 受信側は`event_id`で重複除外し、`timestampMs`を基準にステップを並べる（時計ずれが24時間超なら除外し警告）。同刻なら受信順で安定ソート。
- `observedStarts`はウィンドウ内で最初のステップが観測された試行数。分母が0なら割合は`n/a`。`observedCompletions`は同じコホートのうち終了ステップまで観測できた数（終了がウィンドウ外にまたがる場合は指定したgrace期間内を含む）。
- ステップ率=`reached/observedStarts`、直前ステップからの転換率も計算可能としCLIに併記。`medianMsFromStart`はそのステップに到達した試行の実測中央値。
- `large_drop`: `observedStarts >= 20`かつ直前ステップ到達数>=20、次ステップへの到達率<60%の場合に候補を表示。閾値は設定可能。
- `slow_step`: 有効サンプル>=20かつ前段からの中央値が設定閾値を超えた場合だけ表示。時間がかかった理由やユーザー感情を断定しない。
- `sampleStatus`: 開始試行20未満は`insufficient`。サンプルが少なくても生の到達数は表示するが、改善を断定しない。
- `findings[].evidence`には観測期間・分子・分母・中央値・除外イベント件数などを含む。LLMによる推測はしない。

### 5.3 レポート例（架空）

```text
$ npx @journeygap/cli report --db ./data/journeygap.db --journey first-task --days 7
Journey: first-task     Samples: 42     Window: last 7 days
started    42/42 (100%)
reviewed   27/42 (64.3%)
completed  17/42 (40.5%)

Finding: reviewed -> completed の到達率 63.0%（27件中17件）。
Interpretation: 次の操作の発見しやすさ・エラー・中断などを確認する価値がある。
Note: これは原因の証明ではありません。
```

## 6. JourneyGap Relay（参照受信サービス）

Relayは**OTLP/HTTP JSONの受信・検証・保存・任意転送**だけを担当する小さなNode.jsプロセス。アプリと同じリポジトリに入れない。Node.js 24+、SQLite、軽量なHTTPルーターを採用し、Dockerで実行できるようにする。

### 6.1 受信サービスの設定

Relayには`journeygap.relay.json`（サンプルを`deploy/`に同梱）を渡す。最低限、`allowedOrigins`、`services`（`serviceName`とjourney定義の組）、`retentionDays`、`rateLimitPerMinute`を持つ。デフォルトで`0.0.0.0`への公開起動は行わず、ローカルでは`127.0.0.1`にバインドする。コンテナ公開時は運用者がリバースプロキシとTLSを設定する。Web SDKとRelayは同じ`JourneyDefinition` JSON Schemaを共有する。

```json
{
  "schemaVersion": 1,
  "allowedOrigins": ["http://localhost:5173"],
  "services": [{
    "serviceName": "sample-web",
    "journeys": [{
      "id": "first-task",
      "steps": [
        { "id": "started" },
        { "id": "reviewed" },
        { "id": "completed", "terminal": true }
      ],
      "timeoutMinutes": 30
    }]
  }],
  "retentionDays": 14,
  "rateLimitPerMinute": 60
}
```

### 6.2 HTTP API

| メソッド | パス | 認証 | 動作 |
| --- | --- | --- | --- |
| `OPTIONS` | `/v1/traces` | 不要 | 構成したOriginのCORS preflight |
| `POST` | `/v1/traces` | 公開ブラウザ送信用 | OTLP JSON Traceを受信、JourneyGap Spanのみ保存 |
| `GET` | `/healthz` | 不要 | プロセス状態のみ。内部構成を返さない |
| `GET` | `/admin/v1/report` | 管理トークン必須 | 計測レポートJSON。`journey`, `days` クエリ |

- `POST /v1/traces`はOTLP標準のJSON Protobuf mappingに基づく`resourceSpans[].scopeSpans[].spans[]`を解析する。JourneyGapに属さないSpanは保存も転送もしない。上流へは**検証・サニタイズ後の許可済みSpanだけでOTLP envelopeを再構築**して送る（未検証の元payloadを転送しない）。
- リクエスト上限256 KiB、timeout 5s、JSON depth/配列上限、無効Content-Type拒否、バリデーション失敗時`400`、成功時OTLPの空成功レスポンスを`200 application/json`で返す。
- `journeygap.schema_version=1`かつ`journeygap.event_type=step`で、許可済みservice名・journey/step ID・UUIDの形式を満たすものだけ保存。OTLP属性値の`stringValue/intValue/boolValue/doubleValue`を正規化して検証。
- 管理APIはインターネット公開を前提にしない。必須のサーバー専用トークンまたはループバック制限を利用する。ブラウザに管理トークンを埋め込まない。
- `ALLOWED_ORIGINS`は必須で本番時`*`を拒否。ただしOrigin/CORSは本人認証ではなく、外部クライアントに偽装され得る。公開運用ではTLS終端のリバースプロキシ、IP/送信量レート制限、WAF、監視、クォータが必要。匿名公開テレメトリーはデータ汚染リスクを受容した設計であると明記する。
- IPはレート制限に一時利用してよいがDBに永続化・ログ記録しない。アクセスログのIP出力も既定OFF。
- TTL削除: イベントデータの既定保持14日。定期ジョブで期限切れレコードを削除。分析出力も個人単位の行動履歴を公開しない。

### 6.3 SQLiteテーブル

```sql
CREATE TABLE journey_events (
  event_id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  app_version TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  timestamp_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  step_id TEXT NOT NULL
);
CREATE INDEX idx_journey_window ON journey_events(service_name, journey_id, timestamp_ms);
CREATE INDEX idx_journey_instance ON journey_events(instance_id, timestamp_ms);
```

ナビゲーションやエラーも必要なら別テーブル`client_events`に保存する（MVPでは`navigation`と`error_kind`の集計のみ、元URL・スタック・テキストは保存しない）。DBは単一プロセス・単一インスタンス前提でWALを有効にし、マイグレーションをバージョン管理する。SQLite DBは`.gitignore`対象。

### 6.4 任意OTLPアップストリーム

- `JOURNEYGAP_UPSTREAM_OTLP_TRACES_ENDPOINT`（省略可能）を設定した場合だけ、受信したOTLP JSONを指定した`/v1/traces`へHTTPで転送する。
- `JOURNEYGAP_UPSTREAM_AUTH_HEADER`はサーバー環境変数またはSecret Managerからだけ読み取る（秘密ヘッダーをイベント・ログ・レスポンスに出さない）。
- 転送先はCollector、Jaeger、OTLP互換のクラウドサービス等。Grafana固有のURL・API・Faroをコードにハードコードしない。受信側のサービス/ジャーニー許可リストと、アップストリームへ送るSpan属性の許可リストは同じ設定を使う。
- 受信保存の成功をアップストリームの成功とは混同しない。MVPの転送はbest effort、失敗を集計・診断し、無制限のリトライや巨大なキューを持たない。将来の保証付き配送は別機能。
- URLはサーバー起動時に指定した固定のHTTPS先に限定（本番）。イベント内から転送先を選べないようにしてSSRFを防ぐ。

### 6.5 オフライン分析

`journeygap import --input <path> --db <path>` はCollectorのfile exporterなどから出た**改行区切りのOTLP JSON**を読み込み、同じ検証・重複除去を行う。`report`はSQLiteを読み込む。これによりRelayを通らず任意のOTLP受信先へ直接送った場合も、**データをOTLP JSONとして取得できれば**分析できる。任意バックエンドが標準の検索APIを提供するとは仮定しない。

## 7. CLI仕様：1コマンド導入・削除

### 7.1 コマンド

```bash
# Vite + TypeScriptプロジェクトのルートで実行
npx @journeygap/cli init --endpoint https://ingest.example.org/v1/traces

# 設定・ブラウザ送信可否の診断
npx @journeygap/cli doctor

# 導入したファイル/設定を取り除く
npx @journeygap/cli uninstall

# ローカルのOTLP JSONをインポートし分析
npx @journeygap/cli import --input ./traces.jsonl --db ./journeygap.db
npx @journeygap/cli report --db ./journeygap.db --journey first-task --days 7
```

これは目標とするCLIであり、まだ公開済みではない。バージョンを固定した`npx @journeygap/cli@<version>`での導入も案内する。

### 7.2 `init` 対応条件と処理

対象は`package.json`、Vite設定、TypeScriptのエントリーファイル（例: `src/main.ts` / `src/main.tsx`）を持つnpm/pnpm利用のWebアプリ。既存のGit変更を削除・上書きしない。

1. プロジェクトを検出し、対応外の場合は**変更せず**エラーを返す。
2. JSON Schemaでendpointの形式と設定を検査。値が未指定なら`enabled:false`の設定を生成し、送信は開始しない。
3. `@journeygap/web`を対象アプリの依存に追加する（既存lockfileに応じたパッケージマネージャーを使用）。
4. `journeygap.config.json`、`src/journeygap.bootstrap.ts`、`.journeygap-install.json`を生成。生成ファイルには自動生成ヘッダーを付ける。
5. TS ASTを使い、エントリーファイルの**明示的な管理マーカー付き領域**にbootstrapのimport/初期化を挿入。既存コードを正規表現で全面置換しない。
6. 依存導入・ファイル差分・型検査（実行可能なら）に失敗した場合、JourneyGapが加えた変更を元に戻す。最初から存在した変更は保全する。
7. 既に導入済みなら重複挿入しない。設定変更は`--force`で自動上書きせず、差分を示して明示承認を取る。

`src/journeygap.bootstrap.ts`は`initJourneyGap(config)`の呼び出しのみを記述。アプリ固有のデータ参照を含めない。DOM/SPA navigationはSDKが自動で観測し、目的達成の詳細は公開APIの任意接続により拡張する。

### 7.3 `uninstall` と修復

- `.journeygap-install.json`に生成ファイルのパス・SHA256・挿入マーカー・追加した依存名・変更前の必要箇所のハッシュを記録する。秘密情報を含めない。
- CLIは「自分が挿入した管理領域」だけを取り除く。生成ファイルがユーザーにより編集されている場合は勝手に削除せず、差分と手動手順を示して停止。
- 追加した依存が他のコードから利用されている場合は削除しない。ユーザーの既存lockfile変更は保全する。
- 再実行可能であること（`init`×2、`uninstall`×2）。アンインストール後、アプリを再ビルドできること。
- Git管理下では原則Gitの変更差分を示すが、`git reset --hard`や履歴改変は一切実行しない。

### 7.4 `doctor` の確認事項

接続先URLの形式、HTTPS、公開Bundleへの認証ヘッダーの混入、同意の設定、CORSのプリフライト、CSP`connect-src`、導入マーカー、OTLPエクスポーターの設定。認証情報やユーザーデータをダンプしない。CORS検査は指定Originで実行し、ブラウザでの成功を保証するものとは表記しない。

## 8. セキュリティ、プライバシー、公開OSS運用

### 8.1 ブラウザ計測の必須条件

- opt-inが成立するまで計測SDKのネットワーク送信は0件。拒否後も0件。撤回時は以後の送信停止＋未送信バッファ破棄。撤回以前に受信済みのデータは保持期間に従い削除する。
- 小型同意UIは「許可」「拒否」が同等に選べ、キーボード操作・スクリーンリーダー対応。アプリの通常UIをブロックしない。
- 生の入力、URL全文、クエリ、フラグメント内の動的値、Cookie、localStorage内容、ネットワークBody、例外メッセージ・スタック、利用者IDを送らない。
- エンドポイントは公開情報であり、**秘密のOTLP認証ヘッダーを静的サイトのJavaScriptに埋め込まない**。秘密が必要なバックエンドへはRelay/Collector等のサーバー側から転送する。
- 実運用の公開RelayはTLS、Origin制限、レート制限、容量制限、監査、権限分離を運用前提とする。CORSはセキュリティ認証ではない。
- SDKが無効または通信障害のとき、ゲーム・業務ロジック等の呼び出し結果と例外の振る舞いは変えない。

### 8.2 公開リポジトリのルール

- `LICENSE`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、変更履歴、サンプル環境変数を同梱する。
- リポジトリに実トークン、収集した利用者データ、実サイトのトレース、DB、`.env`、認証付きURLをコミットしない。
- CIでsecret scanning、依存脆弱性確認、型検査、lint、unit、E2E、ライセンス確認、ビルドを実行。GitHub Actionsは最小権限・信頼できるアクションをSHA固定。
- `npm publish`はタグ・手動承認・provenanceを検討し、公開パッケージ名の空き状況と権利関係をリリース前に確認する。名前は仮。
- 攻撃可能性のある外部入力（OTLP JSON、設定値、レポートのCLI引数）はすべて検証する。SQLはプレースホルダーを使用し、管理APIは認証必須。
- サンプルには架空データのみを使用。スクリーンショットやCIのログに実個人情報を載せない。
- APIのSchema versionは後方互換を維持し、破壊変更はメジャーバージョンで行う。

## 9. バックエンド非依存性を検証する構成

### 9.1 ローカル参照構成

- `docker compose up`でJourneyGap Relay、必要ならOTel CollectorとJaegerを起動する。
- デモのブラウザが`http://localhost:<relay-port>/v1/traces`へ送る。ローカル開発のみHTTPを許可。本番はHTTPS必須。
- 管理レポートはRelayのSQLiteから生成するため、Grafanaのアカウントを必要としない。
- Collectorを起動した場合、別のexporterへ転送してもJourneyGapの分析結果は同じになることを確認する。

### 9.2 任意OTLP送信先の例

| 送信先 | ブラウザから直接送る条件 | JourneyGap分析の方法 |
| --- | --- | --- |
| JourneyGap Relay | CORS・TLS・公開受信の防御策 | Relay SQLite、CLI/API |
| OpenTelemetry Collector | OTLP/HTTP、CORS、公開入口の保護が整備済み | OTLP JSONを出力してimport、またはRelay経由 |
| Jaeger等のOTLP受信先 | ブラウザ公開に適した入口が用意されている | Relay経由、またはOTLPデータを取得・importできる場合 |
| Grafana Cloud等の認証付きSaaS | ブラウザ内に秘密を置かないため通常はRelay/Collector経由 | Relay SQLite、バックエンド固有APIはMVP必須にしない |

送信互換性と分析互換性を区別する。OTLPを受け取れるだけではJourneyGapレポートを直接生成できるとは限らない。

### 9.3 GitHub Pagesなど静的ホスティング

Web SDKはブラウザで動くためGitHub Pages、Cloudflare Pages、Netlifyなどに導入可能。ただし**静的ホスティングだけでRelayも動くわけではない**。分析を自動化したい場合は外部のRelayかCollector/後処理基盤を用意する。サーバーを一切使いたくない場合は、対応OTLP受信サービスへの送信のみを使い、分析データは別途取り出してCLIに取り込む。

## 10. 性能・耐障害性

- SDK初期化はアプリ主処理の成否に関与しない。設定不正時は計測だけ停止する。
- 操作イベントの生成でネットワーク同期呼び出しをしない。メモリキュー最大100イベント、超過時は古いイベントを破棄し、ドロップ件数のみ診断モードで報告。
- 定期バッチ送信間隔5秒、最大20イベント/バッチ、HTTPタイムアウト3秒、限定的な再試行（最大2回、指数バックオフ）。離脱時の送信はbest effortで、送達保証はしない。
- 同意後の計測処理によるメインスレッドの継続ブロックを避ける。E2Eで計測ON/OFFのアプリ応答差を確認する。
- Relayが停止した場合もアプリは正常動作。送れなかったイベントは原則捨て、ブラウザへの永続送信キューは作らない。
- 保存期間を超えたイベントを削除。メモリ・ディスク・送信量のクォータを設定可能にする。

## 11. テスト要件と受け入れ基準

### 11.1 Unit / Integration / E2E

| ID | テスト | 必須結果 |
| --- | --- | --- |
| T-01 | 設定JSON Schema検証 | 不正なendpoint、journey重複、未定義stepを拒否 |
| T-02 | consent未同意 | ネットワーク送信・OTel初期化とも0件 |
| T-03 | consent拒否・撤回 | 送信停止、バッファ廃棄、アプリは正常動作 |
| T-04 | イベントの属性マスキング | 自由記述・URL・メール等を外部送信しない |
| T-05 | 2つのjourneyの並列進行 | 正しいinstanceごとに到達集計できる |
| T-06 | stepの順序入替・重複 | 重複除外、out_of_order判定、到達率を水増ししない |
| T-07 | タイムアウト・未観測 | 離脱と断定せず`not_observed_after_timeout` |
| T-08 | Relay停止・OTLPエラー | Webアプリは正常。キュー制限を守る |
| T-09 | OTLP互換性 | 標準CollectorのOTLP/HTTP JSON受信で成功 |
| T-10 | フォワード先切替 | Relayの集計は同じ、上流を差し替え可能 |
| T-11 | `init`二重実行 | 依存・import・設定が重複しない |
| T-12 | `uninstall` | 自動追加コードを除去、元アプリがビルドできる |
| T-13 | 既存ファイルが編集済み | 勝手に上書き・削除せず説明して停止 |
| T-14 | ビルドした静的サイト | サブパス配信、hash routing、CSP下でも検証可能 |
| T-15 | 管理API | 認証なしは拒否、秘密はレスポンスに露出しない |
| T-16 | 低サンプル | 事実の件数は表示するが「原因確定」はしない |
| T-17 | クラウド非依存性 | 外部SaaSのアカウントなしで全必須テスト通過 |
| T-18 | 実ファイルなしの公開テスト | デモ・fixtureのみでCIが完了し秘密を必要としない |

### 11.2 最終受入基準（MVP Done）

- `pnpm install && pnpm build && pnpm test && pnpm test:e2e`が公開リポジトリのクローンだけで実行できる（E2Eに必要なローカルRelayはtest setupが起動）。
- ViteサンプルアプリにCLIで導入でき、同意後にルート遷移がOTLPとして送信され、定義したジャーニーが観測される。
- Relayを使う構成と、標準OpenTelemetry Collectorへ送る構成の双方で正しいOTLP受信を確認する。
- 20件以上の架空fixtureで到達率・時間・未達成のレポートが計算できる。
- 同意拒否、Relay停止、CORS拒否でもアプリ正常動作・秘密漏洩なし。
- `init → build → uninstall → build`を自動テストで完走する。
- READMEだけでローカル起動・1コマンド導入・送信先変更・分析・削除が再現可能。

## 12. 実装順序

### Phase 0 — OSSの足場

pnpm monorepo、CI、公開向けドキュメント、依存固定、サンプルViteアプリ、サンプルジャーニー、fixture。**完了判定:** 誰でもサンプルを起動・テストできる。

### Phase 1 — Web SDKとOTLP

同意管理、公開API、イベントスキーマ、匿名セッション、OTLP/HTTP JSON送信、navigation計測。**完了判定:** 標準Collectorで受信でき、同意前は送信0件。

### Phase 2 — Relayと分析

OTLP受信、SQLite、admin report、データ削除、順序付きジャーニー集計、オフラインimport、任意上流転送。**完了判定:** 外部SaaSなしで分析可能、任意OTLPに転送可能。

### Phase 3 — 導入CLIと受入

`init`, `doctor`, `uninstall`, `report`, `import`、冪等インストールと安全なアンインストール、E2E、パフォーマンス検証。**完了判定:** 11.2の受入を全て満たす。

## 13. 公開・リリース条件

- リリース名・npmスコープの利用可否と商標を確認（`@journeygap/*`は仮称）。
- CIの`build/test/e2e/lint/typecheck/audit`が成功する。
- サンプルの接続先・鍵はダミー、公開リポジトリへの実秘密・実利用者ログ混入0件。
- データ収集についてWebサイト運営者向けのプライバシー説明テンプレートを提供する。
- SemVer、changelog、移行手順、Security reporting窓口を明記する。
- パッケージ公開と実デプロイは、認証方法・リポジトリ権限を確認した後に別途行う。

## 14. 参考資料（仕様の根拠・実装時に再確認）

- [OpenTelemetry: OTLP仕様](https://opentelemetry.io/docs/specs/otlp/) — OTLP/HTTP JSON、`/v1/traces`、Content-Type、エラーハンドリング
- [OpenTelemetry: JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/) — ブラウザのOTLP、CORS、CSP、公開Collectorの注意点
- [OpenTelemetry: JavaScript status](https://opentelemetry.io/docs/languages/js/) — Traces/Logsの安定性
- [OpenTelemetry Collector OTLP receiver](https://github.com/open-telemetry/opentelemetry-collector/blob/main/receiver/otlpreceiver/README.md) — CORSとOTLP受信
- [Grafana Cloud OTLP ingest](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/) — 任意のOTLPアップストリーム例（必須ではない）

---

**補足:** この仕様のコマンド・パッケージ・管理APIは開発目標であり、現時点で利用できるものではない。送信先にOTLP互換性があっても、認証・CORS・公開入口のセキュリティ設計は環境ごとに必要である。
