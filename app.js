const $ = (id) => document.getElementById(id);
const uploadView = $('uploadView');
const resultView = $('resultView');
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const output = $('output');
const globalNotice = $('globalNotice');
const notice = $('notice');
let targetExtension = '';
let targetFilename = '';

$('selectButton').addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => fileInput.files[0] && processFile(fileInput.files[0]));

['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', (event) => {
  const files = event.dataTransfer.files;
  if (files.length !== 1) return showError('ファイルは1つだけ選択してください。');
  processFile(files[0]);
});

$('resetButton').addEventListener('click', reset);
$('clearButton').addEventListener('click', () => {
  output.value = '';
  output.focus();
  clearMessages();
});
$('copyButton').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    const button = $('copyButton');
    button.textContent = 'コピーしました';
    setTimeout(() => button.textContent = 'コピー', 1600);
  } catch {
    output.select();
    document.execCommand('copy');
  }
});
$('downloadButton').addEventListener('click', downloadResult);

async function processFile(file) {
  clearMessages();
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['rtf', 'md'].includes(extension)) {
    return showError('リッチテキストファイルか、マークダウンファイルを選んでください。');
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = extension === 'rtf'
      ? bytesToBinaryString(bytes)
      : new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    if (extension === 'rtf' && !/^\s*\{\\rtf/i.test(text)) {
      throw new Error('このファイルは有効なRTF形式ではありません。');
    }
    const converted = extension === 'rtf' ? rtfToMarkdown(text) : text;
    targetExtension = extension === 'rtf' ? 'md' : 'rtf';
    targetFilename = replaceExtension(file.name, targetExtension);
    // RTFの制御文字列は人が読みにくいため、MD→RTFでは元のMarkdownを
    // 編集用として表示し、ダウンロード時に最新内容からRTFを生成する。
    output.value = extension === 'md' ? text : converted;
    $('outputLabelText').textContent = extension === 'md' ? 'RTFに変換する内容' : '変換結果';
    $('editorHelp').textContent = extension === 'md'
      ? 'ここではMarkdownのまま編集できます。ダウンロード時に書式付きRTFへ変換されます。'
      : '内容を確認・編集してからMarkdownとしてダウンロードできます。';
    $('sourceName').textContent = file.name;
    $('targetName').textContent = targetFilename;
    $('resultMessage').textContent = extension === 'rtf'
      ? 'リッチテキストファイルがMarkdownに変換されました。'
      : 'Markdownファイルがリッチテキストに変換されました。';
    uploadView.hidden = true;
    resultView.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showError(error.message || '変換中にエラーが発生しました。');
  }
}

function reset() {
  fileInput.value = '';
  output.value = '';
  targetFilename = '';
  resultView.hidden = true;
  uploadView.hidden = false;
  clearMessages();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(message) {
  const box = resultView.hidden ? globalNotice : notice;
  box.textContent = message;
  box.hidden = false;
}

function clearMessages() {
  [globalNotice, notice].forEach((box) => { box.hidden = true; box.textContent = ''; });
}

function downloadResult() {
  try {
    const mime = targetExtension === 'rtf' ? 'application/rtf' : 'text/markdown;charset=utf-8';
    const downloadContent = targetExtension === 'rtf' ? markdownToRtf(output.value) : output.value;
    const blob = new Blob([downloadContent], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = targetFilename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    showError('ダウンロードを開始できませんでした。');
  }
}

function replaceExtension(name, extension) {
  return name.replace(/\.[^.]+$/, '') + '.' + extension;
}

// RTFはShift_JISなどのバイト列を含むことがあるため、最初からUTF-8として
// 読まず、各バイトをそのまま保持してRTF内のコードページ指定に従って復号する。
function bytesToBinaryString(bytes) {
  let result = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return result;
}

function rtfToMarkdown(rtf) {
  const destinations = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'generator', 'listtable', 'listoverridetable', 'datastore', 'themedata']);
  const stack = [];
  let state = { skip: false, uc: 1, bold: false, italic: false, strike: false, fontSize: 24, list: false };
  let result = '';
  let pendingFallback = 0;
  const codePageMatch = rtf.match(/\\ansicpg(\d+)/i);
  const codePage = codePageMatch ? Number(codePageMatch[1]) : 1252;

  const marker = (kind, enabled) => {
    const token = kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~';
    if (state[kind] !== enabled && !state.skip) result += token;
    state[kind] = enabled;
  };

  for (let i = 0; i < rtf.length;) {
    const char = rtf[i];
    if (char === '{') { stack.push({ ...state }); i++; continue; }
    if (char === '}') {
      const previous = stack.pop();
      if (previous) {
        ['bold', 'italic', 'strike'].forEach((kind) => {
          if (state[kind] !== previous[kind] && !state.skip && !previous.skip) {
            result += kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~';
          }
        });
        state = previous;
      }
      i++; continue;
    }
    if (char === '\\') {
      // TextEditなどのRTFは、行末のバックスラッシュ＋実改行で
      // 文書内の改行を表すことがある。制御語として捨てず改行へ変換する。
      if (rtf[i + 1] === '\r' || rtf[i + 1] === '\n') {
        if (!state.skip && pendingFallback <= 0) result += '\n';
        i += rtf[i + 1] === '\r' && rtf[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (rtf[i + 1] === '\\' || rtf[i + 1] === '{' || rtf[i + 1] === '}') {
        if (!state.skip && pendingFallback-- <= 0) result += rtf[i + 1];
        i += 2; continue;
      }
      if (rtf[i + 1] === "'") {
        const bytes = [];
        while (rtf[i] === '\\' && rtf[i + 1] === "'" && /^[0-9a-fA-F]{2}$/.test(rtf.slice(i + 2, i + 4))) {
          bytes.push(parseInt(rtf.slice(i + 2, i + 4), 16));
          i += 4;
        }
        if (!state.skip) {
          if (pendingFallback > 0) pendingFallback = Math.max(0, pendingFallback - bytes.length);
          else result += decodeRtfBytes(bytes, codePage);
        }
        continue;
      }
      const match = rtf.slice(i).match(/^\\([a-zA-Z]+)(-?\d+)? ?/);
      if (!match) { i += 2; continue; }
      const word = match[1].toLowerCase();
      const value = match[2] === undefined ? 1 : Number(match[2]);
      i += match[0].length;
      if (destinations.has(word)) { state.skip = true; continue; }
      if (word === 'uc') { state.uc = value; continue; }
      if (word === 'u') {
        if (!state.skip) result += String.fromCharCode(value < 0 ? value + 65536 : value);
        pendingFallback = state.uc;
        continue;
      }
      if (state.skip) continue;
      if (word === 'b') marker('bold', value !== 0);
      else if (word === 'i') marker('italic', value !== 0);
      else if (word === 'strike') marker('strike', value !== 0);
      else if (word === 'par' || word === 'line') result += '\n';
      else if (word === 'tab') result += '\t';
      else if (word === 'emdash') result += '—';
      else if (word === 'endash') result += '–';
      else if (word === 'bullet') result += '•';
      else if (word === 'lquote' || word === 'rquote') result += '’';
      else if (word === 'ldblquote' || word === 'rdblquote') result += '”';
      else if (word === 'fs') state.fontSize = value;
      continue;
    }
    if (!state.skip) {
      if (pendingFallback > 0) pendingFallback--;
      else if (char !== '\r' && char !== '\n') {
        if (char.charCodeAt(0) > 127) {
          const bytes = [];
          while (i < rtf.length && rtf.charCodeAt(i) > 127) {
            bytes.push(rtf.charCodeAt(i) & 0xff);
            i++;
          }
          result += decodeRtfBytes(bytes, codePage);
          continue;
        }
        result += char;
      }
    }
    i++;
  }

  return result
    .replace(/\u0000/g, '')
    .replace(/^\s*•\s*/gm, '- ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '')
    .replace(/^(\*\*|\*)(.+)\1$/gm, '$&')
    .trim() + '\n';
}

function decodeRtfBytes(bytes, codePage) {
  if (!bytes.length) return '';
  const encodings = {
    65001: 'utf-8',
    932: 'shift_jis',
    936: 'gbk',
    949: 'euc-kr',
    950: 'big5',
    1250: 'windows-1250',
    1251: 'windows-1251',
    1252: 'windows-1252',
    1253: 'windows-1253',
    1254: 'windows-1254',
    1255: 'windows-1255',
    1256: 'windows-1256',
    1257: 'windows-1257',
    1258: 'windows-1258'
  };
  try {
    return new TextDecoder(encodings[codePage] || 'windows-1252').decode(new Uint8Array(bytes));
  } catch {
    return bytes.map((byte) => String.fromCharCode(byte)).join('');
  }
}

function markdownToRtf(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const body = [];
  let inCode = false;

  for (const rawLine of lines) {
    if (/^```/.test(rawLine.trim())) { inCode = !inCode; continue; }
    if (inCode) {
      body.push(`{\\f1\\fs20 ${escapeRtf(rawLine)}}\\par`);
      continue;
    }
    const heading = rawLine.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const sizes = [40, 34, 30, 27, 25, 23];
      body.push(`{\\b\\fs${sizes[heading[1].length - 1]} ${inlineMarkdown(heading[2])}}\\par\\par`);
      continue;
    }
    const bullet = rawLine.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      body.push(`\\pard\\li540\\fi-260 \\bullet\\tab ${inlineMarkdown(bullet[1])}\\par\\pard`);
      continue;
    }
    const numbered = rawLine.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      body.push(`\\pard\\li540\\fi-260 ${numbered[1]}.\\tab ${inlineMarkdown(numbered[2])}\\par\\pard`);
      continue;
    }
    const quote = rawLine.match(/^>\s?(.*)$/);
    if (quote) {
      body.push(`\\pard\\li500\\i ${inlineMarkdown(quote[1])}\\i0\\par\\pard`);
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(rawLine)) {
      body.push('\\pard\\brdrb\\brdrs\\brdrw10\\brsp40 \\par\\pard');
      continue;
    }
    body.push(rawLine.trim() ? `${inlineMarkdown(rawLine)}\\par` : '\\par');
  }

  return `{\\rtf1\\ansi\\ansicpg65001\\deff0\n{\\fonttbl{\\f0\\fnil\\fcharset128 Noto Sans JP;}{\\f1\\fmodern\\fcharset0 Menlo;}}\n{\\colortbl;\\red38\\green115\\blue223;}\n\\viewkind4\\uc1\\pard\\f0\\fs24\n${body.join('\n')}\n}`;
}

function inlineMarkdown(text) {
  const links = [];
  let value = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    links.push({ label, url });
    return `@@LINK${links.length - 1}@@`;
  });
  value = escapeRtf(value)
    .replace(/`([^`]+)`/g, '{\\f1 $1}')
    .replace(/\*\*([^*]+)\*\*/g, '{\\b $1}')
    .replace(/__([^_]+)__/g, '{\\b $1}')
    .replace(/~~([^~]+)~~/g, '{\\strike $1}')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '{\\i $1}')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '{\\i $1}');
  return value.replace(/@@LINK(\d+)@@/g, (_, index) => {
    const link = links[Number(index)];
    return `{\\field{\\*\\fldinst HYPERLINK "${escapeRtf(link.url)}"}{\\fldrslt\\ul\\cf1 ${escapeRtf(link.label)}}}`;
  });
}

function escapeRtf(text) {
  let result = '';
  for (const char of text) {
    if (char === '\\' || char === '{' || char === '}') result += '\\' + char;
    else {
      const code = char.charCodeAt(0);
      result += code > 127 ? `\\u${code > 32767 ? code - 65536 : code}?` : char;
    }
  }
  return result;
}
