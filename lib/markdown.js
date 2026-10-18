// 轻量 Markdown 渲染：针对「答案表 + 逐题解析」优化。
// 所有文本先转义再套标签，输出不会引入可执行 HTML。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);
}

function renderInline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) =>
    /^https?:/i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label
  );
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${codes[Number(index)]}</code>`);
}

function splitTableRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')));
}

function emitTable(rows) {
  if (!rows.length) return '';
  let header = null;
  let body = rows;
  if (rows.length >= 2 && isSeparatorRow(rows[1])) {
    header = rows[0];
    body = rows.slice(2);
  }
  const head = header
    ? `<thead><tr>${header.map((c) => `<th>${renderInline(escapeHtml(c))}</th>`).join('')}</tr></thead>`
    : '';
  const tbody = body.length
    ? `<tbody>${body
        .map((row) => `<tr>${row.map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
    : '';
  return `<div class="md-table-wrap"><table>${head}${tbody}</table></div>`;
}

export function renderMarkdown(source) {
  const lines = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let tableRows = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items
      .map((item) => {
        if (!item.indent) return `<li>${item.text}</li>`;
        const depth = Math.min(item.indent, 3);
        return `<li class="nested" data-depth="${depth}">${item.text}</li>`;
      })
      .join('');
    html.push(`<${list.tag}>${items}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushTable = () => {
    if (!tableRows) return;
    html.push(emitTable(tableRows));
    tableRows = null;
  };
  const flushCode = () => {
    if (!code) return;
    html.push(`<pre><code>${code.join('\n')}</code></pre>`);
    code = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    const trimmed = line.trim();

    // 代码块内部原样保留
    if (code) {
      if (/^```/.test(trimmed)) flushCode();
      else code.push(escapeHtml(rawLine));
      continue;
    }
    if (/^```/.test(trimmed)) {
      flushAll();
      code = [];
      continue;
    }

    if (!trimmed) {
      flushAll();
      continue;
    }

    // 表格
    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      if (!tableRows) tableRows = [];
      tableRows.push(splitTableRow(trimmed));
      continue;
    }
    flushTable();

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      html.push('<hr>');
      continue;
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      quote.push(renderInline(escapeHtml(trimmed.replace(/^>\s?/, ''))));
      continue;
    }
    flushQuote();

    // 列表（支持二级缩进：按前导空格数换算层级）
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const indent = Math.floor((bullet || ordered)[1].length / 2);
      const text = (bullet || ordered)[2];
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push({ text: renderInline(escapeHtml(text)), indent });
      continue;
    }
    flushList();

    // 普通段落
    paragraph.push(renderInline(escapeHtml(rawLine)));
  }

  flushAll();
  flushCode();
  return html.join('\n');
}

export function escapeText(value) {
  return escapeHtml(value);
}
