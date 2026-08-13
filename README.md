# mdview

Codex が 1 ターンの間に編集した Markdown を検出し、読みやすいダークテーマの HTML として用意するローカルビューアーです。Hook はブラウザを自動では開きません。生成 HTML、画像、状態ファイルはリポジトリ外に置きます。

## できること

- `Read` / `Changes` / `Raw diff` の切り替え
- 見出し目次、変更箇所ナビゲーション、既読状態、本文幅と文字サイズの調整
- GFM、Shiki のコードハイライト、Mermaid、D2、相対画像
- `UserPromptSubmit` で基準状態を保存し、`Stop` で変更された Markdown だけ再描画
- Hook ではブラウザを開かず、必要なときだけ `mdview` などで手動表示
- `~/.codex/hooks.json` の既存設定を保った install / status / uninstall
- 描画済み文書の履歴一覧と、リポジトリ・ブランチ・パスを横断する検索パレット
- 相対 Markdown リンクを mdview 内で開き、リンク先を描画済み文書へ自動登録

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

引数なしの `mdview` は最後に描画した文書を開きます。Hook による再描画ではブラウザや配信サーバーを起動しないため、確認したいときに `mdview` または `mdview open <番号>` を実行します。`mdview list` の番号は常に新しい順で、`mdview open <番号>` と対応します。番号は新しい描画が加わると変わるため、開く直前の一覧を使います。まだ一度も文書を描画していない場合は、`mdview open <file.md>` で最初の文書を追加します。一覧が保持するのは、現在も原文が存在する各文書の最新プレビューです。過去リビジョンの履歴ではありません。

Reader では `R` / `C` / `D` で `Read` / `Changes` / `Raw diff` を直接切り替えられます。表示モードのボタンにフォーカスがある場合は `←` / `→` でも移動できます。入力欄や検索パレットの操作中は、これらの単キーショートカットは反応しません。`Cmd+K` または `/` で検索パレットを開き、`mdview list` に表示される全文書をタイトル・リポジトリ・ブランチ・パスから検索できます。本文中の相対的な `.md` / `.markdown` リンクを開くと、同じリポジトリ内のリンク先を mdview で描画して移動します。リンク先はその時点で一覧にも登録され、以後 `Cmd+K` の検索対象になります。

キャッシュは `~/Library/Caches/mdview/v1`、hook 状態は `~/Library/Application Support/mdview/hooks`、ログは `~/Library/Logs/mdview` に保存します。Reader のJS、CSS、Mermaidは内容ハッシュ付きのアセットとして保存し、この版で生成した各HTMLが生成時のバージョンを固定参照します。異なるmdviewバージョンが同じキャッシュを使っても、この版で生成したページのアセットは上書きされません。従来名のアセットを参照する古いHTMLは、再描画するとこの形式へ移行します。配信サーバーは `127.0.0.1:4320` のみで待ち受け、キャッシュ配下以外は公開しません。health 応答には互換性確認用のプロトコル版を含めます。

## Hook の境界

`UserPromptSubmit` から正常な `Stop` までの内容差分を検出します。この間に Codex 以外のプロセスが行った編集も区別できません。また、interrupt / error で `Stop` が発火しなかったターンは自動表示されません。古い基準状態は 7 日で削除します。

テスト用に `MDVIEW_CACHE_DIR`、`MDVIEW_STATE_DIR`、`MDVIEW_PORT`、`MDVIEW_BROWSER=none` を指定できます。`MDVIEW_BROWSER=none` ではブラウザと配信サーバーの自動起動を省略します。
