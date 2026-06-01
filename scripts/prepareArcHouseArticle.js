'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT_DIR, 'docs', 'arc-machina-journey-en.md');
const MERMAID_BLOCK_PATTERN = /```mermaid\s*\n([\s\S]*?)```/g;
const NPX_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const DEFAULT_TABLE_THEME = {
  titleHeight: 56,
  headerHeight: 48,
  rowPaddingY: 14,
  cellPaddingX: 16,
  cellPaddingTop: 13,
  lineHeight: 22,
  borderColor: '#D9E0EC',
  headerBackground: '#143A63',
  headerTextColor: '#FFFFFF',
  rowBackgroundA: '#FFFFFF',
  rowBackgroundB: '#F6F9FC',
  textColor: '#1E293B',
  titleColor: '#0F172A',
  fontFamily: 'Arial, Helvetica, sans-serif',
};

function toAbsolutePath(targetPath) {
  if (!targetPath) {
    return DEFAULT_INPUT;
  }

  return path.isAbsolute(targetPath) ? targetPath : path.join(ROOT_DIR, targetPath);
}

function toRepoPath(targetPath) {
  return path.relative(ROOT_DIR, targetPath).replace(/\\/g, '/');
}

function ensureFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing file: ${toRepoPath(targetPath)}`);
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function slugify(value, separator = '-') {
  const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${escapedSeparator}+`, 'g'), separator)
    .replace(new RegExp(`^${escapedSeparator}|${escapedSeparator}$`, 'g'), '') || 'diagram';
}

function stripTrailingPunctuation(value) {
  return String(value || '')
    .replace(/[`*_]/g, '')
    .replace(/[.:;!?]+$/g, '')
    .trim();
}

function toSentenceCase(value) {
  if (!value) {
    return '';
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowerFirst(value) {
  if (!value) {
    return '';
  }

  return value.charAt(0).toLowerCase() + value.slice(1);
}

function humanizeText(value) {
  return String(value || '')
    .replace(/([A-Za-z0-9])\-([A-Za-z0-9])/g, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trimEnd();
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(line) {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line.trim());
}

function normalizeArcHouseMarkdown(markdown) {
  return markdown
    .split('\n')
    .map((line) => humanizeText(line))
    .join('\n');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(value, maxChars) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [''];
  }

  const lines = [];
  let currentLine = '';

  words.forEach((word) => {
    const tentative = currentLine ? `${currentLine} ${word}` : word;
    if (tentative.length <= maxChars || !currentLine) {
      currentLine = tentative;
      return;
    }

    lines.push(currentLine);
    currentLine = word;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function buildTableLabel(markdown, position, tableNumber) {
  const heading = findNearestHeading(markdown, position);
  if (heading) {
    return heading;
  }

  return `Table ${tableNumber}`;
}

function extractTableBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  const lineOffsets = [];
  let offset = 0;
  let tableIndex = 0;

  lines.forEach((line) => {
    lineOffsets.push(offset);
    offset += line.length + 1;
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\|.*\|\s*$/.test(line.trim())) {
      continue;
    }
    if (index + 1 >= lines.length || !isTableDivider(lines[index + 1])) {
      continue;
    }

    const startLine = index;
    let endLine = index + 2;
    while (endLine < lines.length && /^\|.*\|\s*$/.test(lines[endLine].trim())) {
      endLine += 1;
    }

    const tableLines = lines.slice(startLine, endLine);
    tableIndex += 1;
    blocks.push({
      type: 'table',
      tableIndex,
      start: lineOffsets[startLine],
      end: endLine < lineOffsets.length ? lineOffsets[endLine] : markdown.length,
      lines: tableLines,
      rows: tableLines.map(parseTableRow),
      label: buildTableLabel(markdown, lineOffsets[startLine], tableIndex),
    });

    index = endLine - 1;
  }

  return blocks;
}

function buildTableSvg(block) {
  const theme = DEFAULT_TABLE_THEME;
  const headers = block.rows[0].map((cell) => cell.trim());
  const rows = block.rows.slice(2).map((row) => row.map((cell) => cell.trim()));
  const widths = headers.map((_, columnIndex) => {
    if (columnIndex === 0) return 210;
    if (columnIndex === 1) return 430;
    return 390;
  });
  const wrapLimits = widths.map((width) => Math.max(12, Math.floor((width - theme.cellPaddingX * 2) / 8)));
  const tableX = 32;
  const tableY = 32 + theme.titleHeight;
  const title = humanizeText(block.label);

  const wrappedHeaders = headers.map((cell, index) => wrapText(humanizeText(cell), wrapLimits[index]));
  const headerLineCount = Math.max(...wrappedHeaders.map((lines) => lines.length));
  const headerHeight = Math.max(theme.headerHeight, headerLineCount * theme.lineHeight + theme.cellPaddingTop * 2 - 4);

  const wrappedRows = rows.map((row) => row.map((cell, index) => wrapText(humanizeText(cell), wrapLimits[index])));
  const rowHeights = wrappedRows.map((row) => {
    const lineCount = Math.max(...row.map((lines) => lines.length));
    return lineCount * theme.lineHeight + theme.rowPaddingY * 2;
  });

  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const totalHeight = 32 + theme.titleHeight + headerHeight + rowHeights.reduce((sum, value) => sum + value, 0) + 32;
  const totalWidth = tableX * 2 + tableWidth;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">`,
    `<rect width="100%" height="100%" fill="#F3F6FB" rx="24" ry="24"/>`,
    `<text x="${tableX}" y="66" font-family="${escapeXml(theme.fontFamily)}" font-size="28" font-weight="700" fill="${theme.titleColor}">${escapeXml(title)}</text>`,
  ];

  let x = tableX;
  wrappedHeaders.forEach((cellLines, index) => {
    parts.push(`<rect x="${x}" y="${tableY}" width="${widths[index]}" height="${headerHeight}" fill="${theme.headerBackground}" stroke="${theme.borderColor}" stroke-width="1"/>`);
    const textY = tableY + theme.cellPaddingTop + 4;
    parts.push(`<text x="${x + theme.cellPaddingX}" y="${textY}" font-family="${escapeXml(theme.fontFamily)}" font-size="18" font-weight="700" fill="${theme.headerTextColor}">`);
    cellLines.forEach((line, lineIndex) => {
      parts.push(`<tspan x="${x + theme.cellPaddingX}" dy="${lineIndex === 0 ? 0 : theme.lineHeight}">${escapeXml(line)}</tspan>`);
    });
    parts.push('</text>');
    x += widths[index];
  });

  let currentY = tableY + headerHeight;
  wrappedRows.forEach((row, rowIndex) => {
    let rowX = tableX;
    const rowHeight = rowHeights[rowIndex];
    row.forEach((cellLines, cellIndex) => {
      parts.push(`<rect x="${rowX}" y="${currentY}" width="${widths[cellIndex]}" height="${rowHeight}" fill="${rowIndex % 2 === 0 ? theme.rowBackgroundA : theme.rowBackgroundB}" stroke="${theme.borderColor}" stroke-width="1"/>`);
      const textY = currentY + theme.rowPaddingY + 4;
      parts.push(`<text x="${rowX + theme.cellPaddingX}" y="${textY}" font-family="${escapeXml(theme.fontFamily)}" font-size="17" font-weight="400" fill="${theme.textColor}">`);
      cellLines.forEach((line, lineIndex) => {
        parts.push(`<tspan x="${rowX + theme.cellPaddingX}" dy="${lineIndex === 0 ? 0 : theme.lineHeight}">${escapeXml(line)}</tspan>`);
      });
      parts.push('</text>');
      rowX += widths[cellIndex];
    });
    currentY += rowHeight;
  });

  parts.push('</svg>');
  return parts.join('');
}

function renderSvgToPng(svgPath, pngPath) {
  try {
    execFileSync(
      'convert',
      [svgPath, pngPath],
      {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      }
    );
    return true;
  } catch (convertError) {
    // Fall back to svgexport when ImageMagick cannot rasterize the SVG.
  }

  try {
    execFileSync(
      NPX_COMMAND,
      ['-y', 'svgexport', svgPath, pngPath],
      {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      }
    );
    return true;
  } catch (error) {
    console.warn(`PNG export skipped for ${toRepoPath(svgPath)}: ${error.message || String(error)}`);
    return false;
  }
}

function findNearestHeading(markdown, position) {
  const head = markdown.slice(0, position);
  const matches = [...head.matchAll(/^#{1,6}\s+(.+)$/gm)];
  if (!matches.length) {
    return '';
  }

  return stripTrailingPunctuation(matches[matches.length - 1][1]).replace(/^\d+(?:\.\d+)*\.?\s+/, '');
}

function findNearestParagraphLine(markdown, position) {
  const head = markdown.slice(0, position).trimEnd();
  const lines = head.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('```')) {
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      continue;
    }
    if (/^[>*-]\s+/.test(line)) {
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      continue;
    }

    return stripTrailingPunctuation(line);
  }

  return '';
}

function buildDiagramLabel(markdown, position, diagramNumber) {
  const paragraphLine = findNearestParagraphLine(markdown, position);
  const heading = findNearestHeading(markdown, position);

  if (paragraphLine) {
    const secondFlowMatch = paragraphLine.match(/^There is also a second flow that explains how (.+)$/i);
    if (secondFlowMatch) {
      return toSentenceCase(stripTrailingPunctuation(secondFlowMatch[1]));
    }

    if (!/^The cleanest way to understand /i.test(paragraphLine)) {
      return paragraphLine;
    }
  }

  if (heading) {
    return heading;
  }

  return `Diagram ${diagramNumber}`;
}

function extractMermaidBlocks(markdown) {
  const blocks = [];
  let match;
  let diagramIndex = 0;

  while ((match = MERMAID_BLOCK_PATTERN.exec(markdown)) !== null) {
    diagramIndex += 1;
    blocks.push({
      type: 'diagram',
      diagramIndex,
      start: match.index,
      end: MERMAID_BLOCK_PATTERN.lastIndex,
      source: `${match[1].trim()}\n`,
      label: buildDiagramLabel(markdown, match.index, diagramIndex),
    });
  }

  return blocks;
}

function renderDiagram(inputPath, outputPath, options = []) {
  execFileSync(
    NPX_COMMAND,
    ['-y', '@mermaid-js/mermaid-cli', '-i', inputPath, '-o', outputPath, ...options],
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    }
  );
}

function buildArcHouseCopy(markdown, blocks, outputMarkdownPath) {
  let cursor = 0;
  const sections = [
    '> Working copy for Arc House publishing. Remove each placeholder after uploading the referenced PNG in the editor.\n',
    '> Keep the suggested caption directly under the uploaded image.\n',
    '> Search for ARC HOUSE MEDIA SLOT if you want to jump directly to image upload positions.\n',
    '\n',
  ];

  blocks.forEach((block) => {
    const relativeImagePath = path.relative(path.dirname(outputMarkdownPath), block.assetPath).replace(/\\/g, '/');
    const placeholder = [
      `ARC HOUSE MEDIA SLOT ${block.slotIndex}`,
      `Upload image file: ${relativeImagePath}`,
      'Delete this note after the image is in place.',
      `Suggested caption: ${block.label}.`,
      '',
    ].join('\n');

    sections.push(markdown.slice(cursor, block.start));
    sections.push(placeholder);
    cursor = block.end;
  });

  sections.push(markdown.slice(cursor));
  return normalizeArcHouseMarkdown(sections.join(''));
}

function main() {
  const inputMarkdownPath = toAbsolutePath(process.argv[2]);
  ensureFile(inputMarkdownPath);

  const markdown = fs.readFileSync(inputMarkdownPath, 'utf8');
  const diagramBlocks = extractMermaidBlocks(markdown);
  const tableBlocks = extractTableBlocks(markdown);
  const blocks = [...diagramBlocks, ...tableBlocks].sort((left, right) => left.start - right.start);
  if (!blocks.length) {
    throw new Error(`No Mermaid blocks or markdown tables found in ${toRepoPath(inputMarkdownPath)}`);
  }

  const sourceBaseName = path.basename(inputMarkdownPath, path.extname(inputMarkdownPath));
  const assetStem = slugify(sourceBaseName, '_');
  const outputDir = path.join(ROOT_DIR, 'docs', 'generated', assetStem);
  const outputMarkdownPath = path.join(path.dirname(inputMarkdownPath), `${sourceBaseName}.arc-house.md`);

  ensureDir(outputDir);

  let slotIndex = 0;
  blocks.forEach((block) => {
    slotIndex += 1;
    block.slotIndex = slotIndex;

    if (block.type === 'diagram') {
      const diagramStem = `diagram_${String(block.diagramIndex).padStart(2, '0')}`;
      const mmdPath = path.join(outputDir, `${diagramStem}.mmd`);
      const svgPath = path.join(outputDir, `${diagramStem}.svg`);
      const pngPath = path.join(outputDir, `${diagramStem}.png`);

      fs.writeFileSync(mmdPath, block.source, 'utf8');
      renderDiagram(mmdPath, svgPath);
      renderDiagram(mmdPath, pngPath, ['-w', '1600', '-s', '2']);

      block.mmdPath = mmdPath;
      block.svgPath = svgPath;
      block.pngPath = pngPath;
      block.assetPath = pngPath;
      return;
    }

    const tableStem = `table_${String(block.tableIndex).padStart(2, '0')}`;
    const svgPath = path.join(outputDir, `${tableStem}.svg`);
    const pngPath = path.join(outputDir, `${tableStem}.png`);
    fs.writeFileSync(svgPath, buildTableSvg(block), 'utf8');
    const pngCreated = renderSvgToPng(svgPath, pngPath);

    block.svgPath = svgPath;
    block.pngPath = pngCreated ? pngPath : null;
    block.assetPath = pngCreated ? pngPath : svgPath;
  });

  const arcHouseCopy = buildArcHouseCopy(markdown, blocks, outputMarkdownPath);
  fs.writeFileSync(outputMarkdownPath, arcHouseCopy, 'utf8');

  console.log('Prepared Arc House assets:');
  console.log(`- Source: ${toRepoPath(inputMarkdownPath)}`);
  console.log(`- Arc House copy: ${toRepoPath(outputMarkdownPath)}`);

  blocks.forEach((block) => {
    if (block.type === 'diagram') {
      console.log(`- Diagram ${block.diagramIndex} PNG: ${toRepoPath(block.pngPath)}`);
      console.log(`- Diagram ${block.diagramIndex} SVG: ${toRepoPath(block.svgPath)}`);
      return;
    }

    if (block.pngPath) {
      console.log(`- Table ${block.tableIndex} PNG: ${toRepoPath(block.pngPath)}`);
    }
    console.log(`- Table ${block.tableIndex} SVG: ${toRepoPath(block.svgPath)}`);
  });
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}