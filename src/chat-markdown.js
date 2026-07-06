// チャット共通の軽量 Markdown レンダラー（renderer-chat / renderer-stock-chat 共用）。
// 出力前に必ずエスケープするので、LLM 出力をそのまま渡してよい。

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function isTableSeparatorRow(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cell => cell.trim());
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listItems = [];
  let tableRows = [];
  let inCode = false;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  function flushTable() {
    if (!tableRows.length) return;
    let rows = tableRows;
    let headerCells = null;
    if (rows.length >= 2 && isTableSeparatorRow(rows[1])) {
      headerCells = rows[0];
      rows = rows.slice(2);
    }
    const head = headerCells
      ? `<thead><tr>${headerCells.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`
      : "";
    const body = rows
      .filter(cells => !isTableSeparatorRow(cells))
      .map(cells => `<tr>${cells.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
      .join("");
    html.push(`<table>${head}<tbody>${body}</tbody></table>`);
    tableRows = [];
  }

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
      flushParagraph();
      flushList();
      tableRows.push(splitTableRow(trimmed));
      continue;
    }
    flushTable();

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  flushList();
  flushTable();
  return html.join("");
}
