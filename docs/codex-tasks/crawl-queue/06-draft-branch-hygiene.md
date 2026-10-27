# 06 下書き枝の衛生: マージ後の枝削除、見送り下書きの除外、残存枝の整理

## 背景（2026-09-27 実測）

remote の `draft/*` ブランチは 310 本。PR の状態で分けると **MERGED 279／CLOSED 24／OPEN 6／PR なし 1**。

- 承認フロー（`netlify/functions/review-approve-background.js` → `lib/github-api.js` の `mergePR`、squash）は PR をマージするが**枝を消さない**。マージ済みの枝が 279 本残っている。
- `scripts/collect-pending-drafts.js` は「オープンの draft/*」のつもりで **全 draft/* を fetch** し、main に同じファイル名が無い記事を重複判定のコーパスに入れる。そのため**見送り済み（`review_status: skipped`、PR は CLOSED）の下書きが枝の残る限り比較対象に入り続け**、同じ論点の記事を永久に取り下げさせる。実害: eBay 消費税還付の完全ガイドが、9/16 に見送った下書き（closed PR #616）と「重複」で取り下げられた（run 36305380956）。枝を手で消して 3 回目で通った。
- 毎回 310 本を fetch しており、生成の前処理が無駄に重い。

方針: 重複判定のロジックは変えない。**判定に入れる入力（枝）を正しくする**だけ。

## R1 承認フローでマージ成功後に枝を消す

- `review-approve-background.js` で `mergePR` が成功したら、その PR の head 枝を GitHub API で削除する（`DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`）。`lib/github-api.js` に `deleteBranch(branch)` を足す。
- 削除の失敗は致命にしない（ログに出して続行。記事は既に main にある）。`draft/` で始まらない枝名なら削除しない（安全弁）。
- 通知文言は変えない。

## R2 見送り・終了済みの下書きをコーパスから外す

`scripts/collect-pending-drafts.js`:

- 枝ごとの PR 状態を 1 回の呼び出しで取る: `gh pr list --state all --limit 1000 --json headRefName,state,closedAt`（ワークフローには `GH_TOKEN` がある。無い・失敗したときは従来どおり全枝を対象にし、警告を 1 行出す）。
- 次は**対象外**にする: PR が `MERGED` または `CLOSED` の枝、frontmatter の `review_status` が `skipped` / `rejected` / `merged` の記事。
- `OPEN` の枝と、PR が見つからない枝は従来どおり対象（PR 作成前の一瞬を取りこぼさないため）。
- 除外した数を理由別にログに出す（`merged N / closed N / skipped N`）。
- `.pending-drafts.json` の形式は変えない。

## R3 残存枝の整理スクリプト `scripts/prune-draft-branches.js`

手で実行する道具（定期実行には組み込まない。R1 で今後は溜まらない）。

```
node scripts/prune-draft-branches.js            # 一覧だけ（既定 = dry-run）
node scripts/prune-draft-branches.js --apply    # 削除を実行
```

- 対象は `draft/*` だけ。PR が `MERGED` の枝と、`CLOSED` かつ閉じてから 3 日以上経った枝を削除候補にする。`OPEN`・PR なし・`draft/` 以外は**絶対に触らない**（一覧には「対象外」として理由つきで出す）。
- dry-run は「枝名 / PR 番号 / 状態 / 閉じた日 / 判定」の表を出す。`--apply` は `git push origin --delete <枝>…` を 50 本ずつ実行し、失敗した枝は理由つきで最後にまとめる。
- 判定は純関数（`classifyBranches(branches, prs, now)`）に分け、git・gh の呼び出しは差し替え可能にする。

## R4 テスト

`scripts/lib/__tests__/test-draft-branch-hygiene.js`（`npm run masters:test` に追加）:

- `classifyBranches`: MERGED → 削除、CLOSED 3 日超 → 削除、CLOSED 3 日以内 → 保留、OPEN → 対象外、PR なし → 対象外、`feature/x` → 対象外。
- collect の除外: 偽の PR 一覧と偽の frontmatter で `merged/closed/skipped` が落ち、`open` と PR なしが残る。gh が失敗したら全枝が残り警告が出る。
- `deleteBranch`: `draft/` 以外は呼ばない。API 失敗で例外を投げず false を返す。
- `--apply` なしでは `git push` を呼ばない（呼び出し記録で確認）。

## 変更してはいけないもの

- 重複判定そのもの（`ai-dedup.js`、`topic-selector.js`、`checkGeneratedArticle`）。
- 承認・公開の手順と通知文言。
- `content/posts/*.md`。
- OPEN の枝と `draft/` 以外の枝。
