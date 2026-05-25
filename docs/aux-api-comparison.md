# 周辺処理用 API 候補 比較レポート

本文生成（Claude Sonnet 4.6）以外の「周辺処理」を、どこまで安価モデル／ルールベースに寄せるかを検討するための比較資料です。
**この段階では周辺処理用 API を決定しません。** 候補と推奨案のみを提示します。

> ⚠️ 料金・モデルID は変動します。本書の単価は一般的な水準の目安であり、**採用前に各社の最新公式料金ページで必ず確認**してください。確証が持てないものは「要確認」と記載しています。

---

## 1. 周辺処理の分類（tier）

`scripts/lib/aux-task-routing.js` の `AUX_TASKS` が単一の正本です。

| 周辺処理 | tier | 状態 | 実装 |
|---|---|---|---|
| テーマ候補の一次選定 | A | ✅実装済 | topic-selector.js |
| title 案の作成 | B | ✅実装済 | title-builder.js |
| title lint | A | ✅実装済 | title-lint.js |
| frontmatter 補完 | A | ✅実装済 | scenario-expansion.js |
| source_url / source_title 補完 | A | ✅実装済 | tax-authority-refs.js |
| slug 生成 | A | ✅実装済 | scenario-expansion.js |
| category / persona / tax_domain 補完 | A | ✅実装済 | cluster-taxonomy.js |
| main/support ペアチェック | A | ✅実装済 | topic-selector.js |
| duplicate / similarity / cooldown / denylist | A | ✅実装済 | similarity/cooldown/denylist |
| Markdown 表の整形・検査 | A | ✅実装済（本PR） | markdown-table-lint.js |
| 記事構造チェック | A | ✅実装済 | generate-draft.js selfCheck |
| validate 前の preflight | A | ✅実装済（本PR） | preflight-check.js |
| Chatwork 通知文の整形 | A | ✅実装済 | notify/message.js |
| 軽い校正（誤字・表記ゆれ） | C | ⏳API未決定 | （安価モデル候補） |
| **本文生成** | **D** | content_model | content-model.js（Sonnet 4.6）|

- tier A: 完全ルールベース（API不要）
- tier B: ルールベース + 必要時だけ安価モデル
- tier C: 安価モデル向き
- tier D: 高品質モデル（本文生成のみ）

→ **周辺処理はほぼ tier A（ルールベース）で完結。安価モデルが要るのは実質「軽い校正(C)」と「title 仕上げの自然化(B)」のみ。**

---

## 2. 周辺処理用 API / モデル候補 比較表

対象は主に tier B/C（軽い校正・title 自然化・JSON 整形など短い処理）。

| 候補 | 想定用途 | 料金目安(入/出 per 1M) | 品質リスク | 実装難易度 | レイテンシ | prompt cache | JSON安定性 | 日本語 | 税務周辺への向き | 必要な環境変数 | おすすめ度 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **ルールベースのみ** | lint/補完/整形/重複判定 | **0円** | 低（決定論的） | 低 | 即時 | 不要 | 完全 | 強 | ◎（判定系） | なし | ★★★★★ |
| **Anthropic Claude Haiku 系**（claude-haiku-4-5-20251001） | 軽い校正/title自然化/JSON | 要確認（Haiku は Sonnet より大幅安） | 低〜中 | 低（同SDK/同API） | 速 | ✅可 | 高 | 強 | ◎ | ANTHROPIC_API_KEY | ★★★★☆ |
| **OpenAI GPT mini 系**（gpt-5-mini 等／型番要確認） | 同上 | 要確認（mini は安価帯） | 低〜中 | 低（既存openai SDK流用） | 速 | △(自動) | 高 | 中〜強 | ○ | OPENAI_API_KEY | ★★★☆☆ |
| **OpenAI nano 系**（型番要確認） | 整形/分類/超軽量 | 要確認（最安帯） | 中 | 低 | 最速 | △ | 中 | 中 | △（軽量判定向き） | OPENAI_API_KEY | ★★★☆☆ |
| **既存 gpt-5.4 を低 max_tokens で流用** | 軽い校正 | 本文と同単価（割高） | 低 | 最低（追加実装ほぼ無） | 中 | △ | 高 | 強 | ○ | OPENAI_API_KEY | ★★☆☆☆ |
| **ローカル処理のみ**（kuromoji 等の形態素解析） | 表記ゆれ/簡易校正 | 0円 | 中（辞書依存） | 中〜高 | 即時 | 不要 | 完全 | 強 | △ | なし | ★★★☆☆ |

### モデルID メモ（採用時に最新確認）
- 本文生成（確定方針）: **`claude-sonnet-4-6`**
- 周辺処理候補（Anthropic 安価）: Haiku 系 = `claude-haiku-4-5-20251001`（※リリース状況・型番は要確認）
- OpenAI 安価帯（mini/nano）: 型番は OpenAI の最新一覧で要確認

---

## 3. 推奨案

1. **まず tier A をルールベースで固める（本PRで完了）** — 周辺処理の大半はここで API ゼロ。
2. **軽い校正（tier C）が必要になった時だけ Anthropic Haiku 系を採用**するのが第一候補。
   - 理由: 本文 Sonnet 4.6 と**同じ Anthropic SDK / API・同じ prompt cache 機構**を流用でき、実装・運用がシンプル。日本語も強い。
   - 環境変数 `AUX_MODEL_PROVIDER=anthropic` / `AUX_MODEL=claude-haiku-4-5-20251001` を想定（未決定）。
3. **title の最終自然化（tier B）** は現状 `title-builder.js`（ルールベース）で十分自然な出力。必要になれば Haiku に回す。
4. nano/mini 系は「分類・整形だけの超軽量処理」を大量に回す場合の選択肢。現状はそこまでの量がないため優先度低。

→ **結論: 周辺処理は「ルールベース優先 + 必要時のみ Haiku 系」。本文だけ Sonnet 4.6。** 最終決定は別途。

---

## 4. 想定環境変数（最終決定は未）

```
# 本文生成（確定方針）
CONTENT_MODEL_PROVIDER=anthropic
CONTENT_MODEL=claude-sonnet-4-6
CONTENT_MODEL_USE_PROMPT_CACHE=true
ANTHROPIC_API_KEY=...   # Netlify / Actions Secret

# 部分再生成
ENABLE_PARTIAL_REVISE=true       # 部分再生成を有効化（既定 true）

# 周辺処理用（★未決定。候補表を見てから決める）
AUX_MODEL_ENABLED=false
AUX_MODEL_PROVIDER=rule_based     # rule_based / anthropic / openai
AUX_MODEL=                        # 例: claude-haiku-4-5-20251001
```

現行の `OPENAI_*` は当面 fallback として残す想定（Anthropic 障害時に本文生成が止まらないように）。
