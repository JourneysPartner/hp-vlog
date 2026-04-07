'use strict';

/**
 * 通知メッセージ組み立て（プロバイダ共通）
 *
 * イベント種別:
 *   - draft_created : 下書き生成完了
 *   - approved      : 承認完了
 *   - revised       : 差し戻し完了
 *   - skipped       : 見送り完了
 *   - published     : 公開完了
 */

function buildMessage(event, data) {
  switch (event) {
    case 'draft_created': {
      const { title, summary, persona, category, reviewUrl, prUrl } = data;
      const lines = [
        '本日のブログ下書きが生成されました。',
        '',
        `■ タイトル: ${title}`,
        `■ 対象読者: ${persona}`,
        `■ カテゴリ: ${category}`,
        `■ 概要: ${summary}`,
        '',
      ];
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      if (prUrl)     lines.push(`▶ Pull Request: ${prUrl}`);
      lines.push('', 'レビュー画面から内容を確認し、承認・差し戻し・見送りの操作をお願いいたします。');
      return { subject: '【ブログ】下書きが生成されました', body: lines.join('\n') };
    }

    case 'approved': {
      const { title, filename, reviewUrl, publishAt } = data;
      const lines = [
        '記事を承認しました。',
        '',
        `■ タイトル: ${title || filename}`,
      ];
      if (publishAt) lines.push(`■ 公開予定: ${publishAt}`);
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      lines.push('', 'PRをマージすると記事が公開されます。');
      return { subject: '【ブログ】記事が承認されました', body: lines.join('\n') };
    }

    case 'revised': {
      const { title, filename, comment, reviewUrl } = data;
      const lines = [
        '記事に修正依頼がありました。',
        '',
        `■ タイトル: ${title || filename}`,
      ];
      if (comment) lines.push(`■ コメント: ${comment}`);
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      lines.push('', '修正内容は次回の下書き生成時に反映されます。');
      return { subject: '【ブログ】記事が差し戻されました', body: lines.join('\n') };
    }

    case 'skipped': {
      const { title, filename } = data;
      return {
        subject: '【ブログ】記事を見送りました',
        body: `記事を見送りにしました。\n\n■ タイトル: ${title || filename}`,
      };
    }

    case 'published': {
      const { title, publicUrl, category, persona } = data;
      const lines = [
        '記事が公開されました。',
        '',
        `■ タイトル: ${title}`,
      ];
      if (category) lines.push(`■ カテゴリ: ${category}`);
      if (persona)  lines.push(`■ 対象読者: ${persona}`);
      if (publicUrl) lines.push(`▶ 公開URL: ${publicUrl}`);
      return { subject: '【ブログ】記事が公開されました', body: lines.join('\n') };
    }

    default:
      return { subject: event, body: JSON.stringify(data, null, 2) };
  }
}

module.exports = { buildMessage };
