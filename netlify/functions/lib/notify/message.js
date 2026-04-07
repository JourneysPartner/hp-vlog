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
        '本日のブログ下書きができました。',
        '',
        `タイトル: ${title}`,
        `対象読者: ${persona}`,
        `カテゴリ: ${category}`,
        `概要: ${summary}`,
        '',
      ];
      if (reviewUrl) lines.push(`レビュー画面: ${reviewUrl}`);
      if (prUrl)     lines.push(`Pull Request: ${prUrl}`);
      lines.push('', 'レビューをお願いいたします。');
      return { subject: 'ブログ下書きが生成されました', body: lines.join('\n') };
    }

    case 'approved': {
      const { title, filename, reviewUrl } = data;
      return {
        subject: '記事が承認されました',
        body: [
          '記事が承認されました。',
          '',
          `タイトル: ${title || filename}`,
          reviewUrl ? `レビュー画面: ${reviewUrl}` : '',
          '',
          '公開日時の設定をお願いいたします。',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'revised': {
      const { title, filename, comment, reviewUrl } = data;
      return {
        subject: '記事が差し戻されました',
        body: [
          '記事に修正依頼があります。',
          '',
          `タイトル: ${title || filename}`,
          comment ? `コメント: ${comment}` : '',
          reviewUrl ? `レビュー画面: ${reviewUrl}` : '',
          '',
          '修正をお願いいたします。',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'skipped': {
      const { title, filename } = data;
      return {
        subject: '記事が見送りになりました',
        body: `記事を見送りにしました。\n\nタイトル: ${title || filename}`,
      };
    }

    case 'published': {
      const { title, publicUrl } = data;
      return {
        subject: '記事が公開されました',
        body: [
          '記事が公開されました。',
          '',
          `タイトル: ${title}`,
          publicUrl ? `公開URL: ${publicUrl}` : '',
        ].filter(Boolean).join('\n'),
      };
    }

    default:
      return { subject: event, body: JSON.stringify(data, null, 2) };
  }
}

module.exports = { buildMessage };
