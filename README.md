# mdview

Codex が 1 ターンの間に編集した Markdown を検出し、読みやすいダークテーマの HTML として用意するローカルビューアーです。Hook はブラウザを自動では開きません。生成 HTML、画像、状態ファイルはリポジトリ外に置きます。

## できること

- `Read` / `Changes` / `Raw diff` の切り替え
- 見出し目次、同一ファイルの変更履歴ナビゲーション、既読状態、本文幅と文字サイズの調整
- GFM、Shiki のコードハイライト、Mermaid、D2、相対画像
- `UserPromptSubmit` で基準状態を保存し、`Stop` で変更された Markdown だけ再描画
- Hook ではブラウザを開かず、必要なときだけ `mdview` などで手動表示
- `~/.codex/hooks.json` の既存設定を保った install / status / uninstall
- 描画済み文書の最新一覧と、リポジトリ・ブランチ・パスを横断する検索パレット
- ターン単位の Markdown スナップショットと、同じファイルの過去リビジョン参照

## セットアップ

```bash
cd ~/src/github.com/kazuhideoki/mdview
npm install
cd ../dotfiles
stow -t ~ -d stow local-bin
mdview hook install
```

インストール後、Codex の `/hooks` で `UserPromptSubmit` と `Stop` の 2 エントリを個別に trust します。Hook の正常終了時は stdout を一切出しません。

## 使い方

```bash
mdview
mdview list
mdview open 2
mdview open README.md
mdview render README.md
mdview demo
mdview hook status
mdview hook uninstall
```

引数なしの `mdview` は最後に描画した文書を開きます。Hook による再描画ではブラウザや配信サーバーを起動しないため、確認したいときに `mdview` または `mdview open <番号>` を実行します。`mdview list` の番号は常に新しい順で、`mdview open <番号>` と対応します。番号は新しい描画が加わると変わるため、開く直前の一覧を使います。まだ一度も文書を描画していない場合は、`mdview open <file.md>` で最初の文書を追加します。一覧は各文書の最新プレビューだけを表示し、過去リビジョンは Reader 内で参照します。

Reader では `P` で同じファイルの古い版へ戻り、`N` で新しい版へ進みます。各版の `Changes` と `Raw diff` は、そのターンの編集開始時点との差分です。`Cmd+K` または `/` で検索パレットを開き、`mdview list` に表示される全文書をタイトル・リポジトリ・ブランチ・パスから検索できます。

描画キャッシュは `~/Library/Caches/mdview/v1`、履歴の正本は `~/Library/Application Support/mdview/history`、hook 状態は `~/Library/Application Support/mdview/hooks`、ログは `~/Library/Logs/mdview` に保存します。配信サーバーは `127.0.0.1:4320` のみで待ち受け、履歴APIはナビゲーション用メタデータだけを返します。Markdown スナップショット自体は配信しません。health 応答には互換性確認用のプロトコル版を含めます。

## Hook の境界

`UserPromptSubmit` から正常な `Stop` までの内容差分を検出します。この間に Codex 以外のプロセスが行った編集も区別できません。また、interrupt / error で `Stop` が発火しなかったターンは自動表示されません。古い基準状態は 7 日で削除します。

テスト用に `MDVIEW_CACHE_DIR`、`MDVIEW_STATE_DIR`、`MDVIEW_PORT`、`MDVIEW_BROWSER=none` を指定できます。`MDVIEW_BROWSER=none` ではブラウザと配信サーバーの自動起動を省略します。
