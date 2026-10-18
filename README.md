# GROWI Migration Tools

旧CrowiからGROWIへの移行用ツール集。

関連Issue: [traPtitech/growi#1](https://github.com/traPtitech/growi/issues/1)

## 旧Crowiの末尾スラッシュ補正

GROWI v8へのスキーマ移行・公開ページのツリー変換後に使う、MongoDB用の手動スクリプト。

`/teams/` の本文ページと、移行で生成された空の `/teams` が並ぶ場合に、本文ページのIDを残して空の階層を統合する。アプリ起動時の自動実行はなし。

### 実行環境

- Node.js 24以上
- MongoDBのレプリカセット
- GROWI本体のチェックアウトは不要

## 対象と処理

- 末尾の `/` のみを除去。先頭スラッシュ、大小文字、本文中のリンクは変更しない。
- 同じ正規化先に本文ページが1件なら、そのID・revision・作者・日時・アクセス設定を保持。すべて空の階層なら、既存の正規化済み階層を優先する。
- 削除対象の空階層を参照する親子関係、履歴、コメント、添付、ブックマーク、タグ関連、共有リンク、ページへの購読・通知を、残るIDへ付け替える。
- 旧パスからのリダイレクトを追加。既存リダイレクトの移動先と、旧形式の `revisions.path` も更新する。本文・添付オブジェクトキーは書き換えない。
- `descendantCount` を親子関係から再計算。空の階層自体は件数に含めず、ツリー外の旧形式ページは対象外。

次の場合は自動処理せず、レポートの `skipped` に記録する。

- 本文ページ同士の衝突
- アクセス範囲や親の違い
- 旧形式・非公開ツリー未変換
- 既存リダイレクトとの衝突
- revisionを持つ空階層

公開ページに残る旧 `grantedUsers` は閲覧制限ではないため、公開範囲の比較から除外する。元の設定値自体は保持する。

保留中の `pageoperations`、親の参照切れ・循環がある場合は計画の作成を中止する。完了済みの監査ログや出力スナップショットの内容は変更しない。

## ドライラン

リポジトリのルートで依存関係をインストールし、レポートの保存先を作成する。

```sh
pnpm install --frozen-lockfile
mkdir -p reports
```

接続先とDB名を指定して実行する。

```sh
export MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true'

pnpm normalize-trailing-slashes \
  --database growi \
  --report reports/slash-plan.json
```

`--apply` がなければDBへの変更はなし。生成された計画の `merges`・`pageUpdates`・`aliases`・`skipped` を確認する。

実データのパスやIDを含むレポートはgitに追加しないこと。

## 適用

最初は別名DBへ復元したコピーで試すこと。適用対象DBをバックアップし、そのDBに接続するGROWI・ワーカーを停止してから、ドライランで生成した計画を指定する。

```sh
pnpm normalize-trailing-slashes \
  --database growi \
  --apply \
  --plan reports/slash-plan.json \
  --report reports/slash-applied.json
```

適用時にはDB名とページ構造・アクセス設定・リダイレクトのfingerprintを照合し、計画後に変更があれば中止する。変更処理は1トランザクションで実行し、一意制約違反などがあれば参照の付け替えも含めてロールバックする。

`skipped` のグループはパス変更・統合の対象外。ただし、親階層の統合に伴うparent参照の付け替えと、ツリー全体の子孫数再計算は対象に含む。完了した変更を戻す場合は、事前バックアップから復元する。

再実行時は、ドライランで新しい計画を作成する。処理済みのグループは変更対象に入らず、適用済みの古い計画はfingerprint不一致として拒否される。

再起動後はページツリー・旧URL・履歴・権限を確認し、利用している検索インデックスやVault等の派生データを再構築する。このスクリプトからアプリの更新イベントは発行されない。

## 検証

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test

# MongoDB replica set: creates and drops a randomly named test database.
TEST_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' pnpm test
```

通常の `pnpm test` は計画の単体テストのみ。

`TEST_MONGO_URI` を設定すると、指定サーバー内にランダム名の専用DBを作り、参照保持・再実行・古い計画の拒否・制約違反時のロールバックを確認して専用DBを削除する。既存DBの指定は不要。テスト用DBの作成・削除が可能なレプリカセットを使うこと。

## ライセンス

MIT。GROWI内で作成した補正スクリプトを、単独で実行できるようにしたもの。GROWI由来のライセンスは [LICENSE](LICENSE) に同梱。

## 重複ユーザーの統合

`merge-duplicate-users` は、完全一致するユーザー名のレコードを同一人物として統合する手動ツール。各組の最古ObjectIdを残し、そのプロフィール・作成日時・資格情報を保持する。メール、status、管理者・読み取り専用フラグが組内で異なる場合や、統合元に別の外部ID・APIトークン・プロフィールがある場合は中止する。別ユーザー名間のメール重複も中止する。

推奨実行時点は、MongoDBのレプリカセットへ復元後、GROWIのスキーマ移行前。旧CrowiのMongoDB 3.6では実行しない。移行済みGROWIのDBにも利用できる。

### 計画と適用

最初は別名DBへ復元したコピーで検証する。バックアップを取得し、対象DBを利用するGROWI・ワーカーを停止してから実行する。接続先の指定は上記と同じ。

```sh
pnpm merge-duplicate-users \
  --database growi \
  --report reports/users-plan.json

pnpm merge-duplicate-users \
  --database growi \
  --apply --plan reports/users-plan.json \
  --report reports/users-applied.json
```

初回は読み取りだけ。`groups` の統合先・削除元、`changes` と `referenceUpdates` を確認する。計画にはユーザー名・メール・IDを含むため公開しない。レポートは新規ファイルだけに作成し、権限を0600にする。

適用時には入力DB全体のドキュメント・インデックスと仮名化対応表のfingerprintを再照合し、変更後の古い計画は拒否する。実行内容はDBから再計算するため、計画の `changes` を手で書き換えて適用内容を変更することはできない。ドキュメントの照合にはBSON表現を使い、型の違いも検出する。停止状態で計画から適用まで実行すること。

変更は1トランザクションで適用する。ページの作者・最終更新者・削除者・許可ユーザー・既読・いいね、履歴作者、コメント・添付作者、ブックマーク、グループ・外部アカウント等の参照を付け替える。配列は同一人物分を重複排除する。本文・ページID・revision ID・パス・日時・grant・添付キーは変更しない。本文中の旧IDも歴史的記録として保持する。

同一ページのブックマークが衝突する場合は、統合先ユーザーの既存レコードを優先し、なければ最小のブックマークIDを残す。フォルダ内のブックマーク参照も残るIDへ付け替えて重複排除する。UI設定・日別contributionなど、その他の一意制約の衝突は自動統合せず、DBエラーで全変更をロールバックする。

既知の参照を置換した後に、削除対象IDが未対応の構造化フィールドに残る場合は計画を作らず中止する。保留中の `pageoperations` や、削除対象IDを含むセッションも先に解消すること。構造化参照の対象一覧は `src/merge-duplicate-users/references.ts`。新しいモデルを持つDBへ適用する際は、この一覧と各モデルを照合する。

### リハーサル時の仮名からの復元

過去の検証で `rehearsal-...` へ変更したDBは、明示的な対応表を両方のコマンドに指定する。名前の形式からの推測は行わない。

```sh
pnpm merge-duplicate-users \
  --database growi \
  --aliases /private/path/user-aliases.json \
  --report reports/users-plan.json

pnpm merge-duplicate-users \
  --database growi \
  --aliases /private/path/user-aliases.json \
  --apply --plan reports/users-plan.json \
  --report reports/users-applied.json
```

対応表は `{ "id": "24文字のObjectId", "field": "usernameまたはemail", "original": "元の値", "replacement": "仮名" }` の配列。保存値が元の値・仮名のどちらでもなければ中止する。統合先が仮名化されている場合は、元の名前・メールを復元する。削除済みIDの対応表は再実行時に無視する。実データの対応表をgitに追加しない。

適用後は新しいレポートへ再ドライランし、変更0件を確認する。完了したトランザクションを戻す場合は事前バックアップから復元する。GROWIのユーザー削除APIはユーザーホーム・グループ・外部アカウントを変更するため、この統合の代用にはしない。

再起動後はtraQの認証先IDと、旧所有者限定ページ・履歴・ブックマークの利用を確認する。卒業者の利用停止、管理者の見直し、旧APIトークンの廃止はこの処理では行わない。検索やVault等を利用している場合は派生データも再構築する。

## 標準マイグレーション前の補正

`prepare-legacy-migration` は、旧Crowiのデータを移行先MongoDBのレプリカセットへ復元した後、GROWIの標準スキーママイグレーションを実行する前に使う。旧MongoDB 3.6では実行しない。対象DBをバックアップし、接続するアプリ・ワーカー・その他の書き込み元を停止してから計画作成・適用を行う。

- `configs.key` が重複していないことを確認し、`configs.key_1` が通常の非uniqueインデックスなら削除する。欠落・通常のuniqueインデックスは変更しない。uniqueインデックスの作成は標準マイグレーションに任せる。キー欠落・空文字・非文字列、特殊な `key_1` 定義は停止する。
- 先頭 `/` のないページと、同じ旧パスを持つ全履歴の `path` に `/` を補う。`pageId` は設定せず、標準マイグレーションで紐付ける。ID・本文・作者・日時・アクセス設定・添付参照は変更しない。
- 正規化先のページ・履歴が既に存在する場合、最新履歴が旧パスに属さない場合、履歴に `pageId` がある場合、他ページが同じ履歴を最新履歴として参照する場合は停止する。先頭 `/` のないリダイレクトや、そのパスを参照するリダイレクトも手動確認が必要なため停止する。未処理の `pageoperations`、必須コレクション欠落、不正・重複ページパスも停止する。

対象は固定のIDや件数ではなくDBから検出する。元々通常URLで開けなかったページにも `/` を補うため、計画の `pathUpdates` と各項目の `access`（公開範囲・許可ユーザー等）を確認すること。文字列 `undefined` のような不正な名前でも、他の条件を満たせば補正対象になる。アクセス設定は維持するが、通常URLで到達可能になる場合がある。

```sh
export MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true'
mkdir -p reports

pnpm prepare-legacy-migration \
  --database growi \
  --report reports/prepare-plan.json

pnpm prepare-legacy-migration \
  --database growi \
  --apply --plan reports/prepare-plan.json \
  --report reports/prepare-applied.json
```

ドライランは読み取りだけ。計画の `dropConfigIndex`・`pathUpdates` を確認する。レポートは実データのパス・IDを含むため公開しない。新規ファイルだけに作成し、権限を0600にする。

適用時は対象DB名・ツール名・バージョンと、設定キー、ページのパス・最新履歴・リダイレクト・アクセス設定、履歴のID・パス・`pageId`、3コレクションのインデックス定義のfingerprintを再照合する。本文や無関係なコレクションは照合対象外。適用内容はDBから再計算し、計画の変更一覧を書き換えても実行内容は変わらない。

ページと履歴の更新は1トランザクションで確定し、その後、設定キーとインデックスを再照合して旧 `configs.key_1` を削除する。インデックス削除は同じトランザクションに含められない。削除だけに失敗した場合、パス補正は確定済みであることをエラーに表示する。書き込み元の停止を確認し、別名のレポートへ新しい計画を作成して再適用すること。古い計画は再利用しない。正常終了後も再ドライランで変更0件を確認する。完了済みの処理を戻す場合は事前バックアップから復元する。

実行順は、復元 → 重複ユーザー統合・この前処理 → GROWI標準スキーママイグレーション → 公開ページのツリー変換 → 末尾スラッシュ補正。この前処理と重複ユーザー統合の間は、どちらを先に実行してもよいが、それぞれ直前に計画を作成する。履歴のリダイレクト由来の参照切れや、ページ自体がない未紐付け履歴はこのツールの対象外。

検証は上記の共通コマンドを使用する。`TEST_MONGO_URI` 指定時はランダム名の専用DBで、データ保持・標準処理とのパス照合・再実行、既存uniqueインデックスの保持、不正データの拒否、古い計画の拒否、書き込み失敗時のロールバック、インデックス削除失敗後の再開を確認する。既存の開発DBや本番DBへの適用は行わない。


## 添付ファイルのSwift → S3移行・本文URL変換

GROWI標準スキーマ移行後のDBに対して `migrate-attachments` を使う。Swift・S3への接続には、別途インストールした `rclone` とその設定を使用する。認証情報はrclone設定または環境変数で管理し、計画ファイルには書かない。

### 対象

- 添付DBのID・所属ページ・サイズが有効で、保存先キーが `attachment/{24桁ページID}/{32桁ハッシュ}.{拡張子}` のものを移送する。同一キーの添付が複数ある場合、該当レコードはすべて無視する。
- Swiftの `crowi` コンテナ内のキーを、同じキーでS3へコピーする。添付ID・`filePath`・所属ページ・権限・日時等のDBメタデータは変更しない。
- 現行ページが一意に参照し、`revision.pageId` も一致する現行リビジョンの本文のみ更新する。過去のリビジョンは変更しない。
- `/files/{添付ID}`、指定したWiki originの絶対URL、および指定したSwift base以下の保存先キーを、対応する `/attachment/{添付ID}` に変換する。
- Markdownの画像・リンク・参照定義・autolinkと、HTMLの `src` / `href` が対象。コード例やコメントは変換せず、本文の他の部分は整形しない。
- `wordpress`・ランチャー等の別コンテナ、非標準パス、クエリ・フラグメント付きURL、対応する添付がないURL、DB不整合は変更せず無視する。本文への注記・コメント追加やリンク削除は行わない。
- 添付DBにないSwiftオブジェクトは移送しない。ユーザー画像等の別データや、外部サイトからの旧URLの互換処理は対象外。

### ドライラン

`--source` はSwiftの `crowi` コンテナ、`--destination` はS3の保存先ルートを指定する。本文のURLに対応する `--swift-base` と、実ファイルの取得元 `--source` は同じコンテナを指すよう設定する。S3はGROWIから読み取れる非公開バケットを用意する。

```sh
export MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true'
mkdir -p reports

pnpm migrate-attachments \
  --database growi \
  --wiki-origin https://wiki.trap.jp \
  --swift-base https://object-storage.tyo1.conoha.io/v1/nc_TENANT_ID/crowi/ \
  --source swift:crowi \
  --destination s3:BUCKET_NAME \
  --report reports/attachments-plan.json
```

`TENANT_ID` は実際の16進数テナントIDへ置き換える。`swift` / `s3` はrcloneで設定したremote名。ドライランはDB・Swift・S3を変更せず、ストレージへの接続も行わない。計画の `files`、本文の `before` / `after`、対象外添付件数 `skippedAttachments` を確認する。計画・レポートは権限0600で新規作成される。本文を含むため公開しない。

### 適用

DBとSwiftのバックアップを保存し、GROWIとワーカーを停止してから実行する。先に、S3コピー先を他の処理が更新しない状態にする。

上記コマンドの `--report` を別名に変え、次の指定を追加する。DB名・各URL・remoteの指定はドライランと同じにする。

```sh
  --apply \
  --plan reports/attachments-plan.json \
  --report reports/attachments-applied.json
```

1. 現在のDBと計画全体を照合する。不一致なら移送前に停止する。
2. 元ファイルのサイズとSHA-256を計算する。元ファイルがない、または添付DBのサイズと違うものはスキップする。
3. S3の同一キーに既にファイルがあれば内容を照合する。一致すればコピーを省略し、異なれば上書きせず停止する。新規コピー後もサイズ・SHA-256を照合する。
4. 移送後にもう一度DBと計画を照合し、コピーを検証できた添付に対応するURLだけを1トランザクションで変換する。欠損・サイズ不一致のファイルに対応するURLは残す。

認証エラーや通信障害はスキップせずエラーとする。S3とMongoDBをまたぐトランザクションはないため、途中失敗時にコピー済みのファイルはS3に残る。失敗レポートには検証済みIDを保存する。再実行では既存内容を照合して再開できる。DBの状態が変わった場合は新しいドライラン計画を作る。

完了後、GROWIの保存先をS3へ設定し、閲覧権限と画像表示を確認する。検索インデックス・Vault等の派生データは必要に応じて再構築する。ツールからGROWIの更新イベントは発行しない。元のSwiftオブジェクトは削除しない。

`pnpm test` では、rcloneがインストールされていれば一時ローカルディレクトリで実ファイルのコピー・検証・再実行・衝突拒否も確認する。`TEST_MONGO_URI` 指定時は一時DBで現行本文のみの変換と古い計画の拒否を確認する。
