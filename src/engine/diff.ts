// Unified diff for game-sized files. LCS over lines (level files are tiny,
// so O(n*m) is fine) with 3 lines of context and real-git-shaped output.

export interface FileDiffInput {
  oldContent: string | null; // null: file did not exist
  newContent: string | null; // null: file deleted
  oldPath: string;
  newPath: string;
  oldOid?: string;
  newOid?: string;
}

type LineOp = { type: 'keep' | 'del' | 'add'; line: string };

function lcsOps(a: string[], b: string[]): LineOp[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'keep', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ type: 'del', line: a[i] });
    i++;
  }
  while (j < n) {
    ops.push({ type: 'add', line: b[j] });
    j++;
  }
  return ops;
}

const CONTEXT = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, '').split('\n');
}

// git omits the count when it is exactly 1: "@@ -1 +1,3 @@"
const range = (start: number, count: number): string =>
  count === 1 ? `${start}` : `${start},${count}`;

function hunks(oldLines: string[], newLines: string[]): string[] {
  const ops = lcsOps(oldLines, newLines);

  let oldNo = 0;
  let newNo = 0;
  const tagged = ops.map((op) => {
    const t = { op, oldLine: 0, newLine: 0 };
    if (op.type !== 'add') t.oldLine = ++oldNo;
    if (op.type !== 'del') t.newLine = ++newNo;
    return t;
  });

  const changeIdx = tagged
    .map((t, idx) => (t.op.type === 'keep' ? -1 : idx))
    .filter((x) => x >= 0);
  if (changeIdx.length === 0) return [];

  // Group changes; hunks merge when the gap between them is <= 2 * CONTEXT.
  const groups: Array<[number, number]> = [];
  let gStart = Math.max(0, changeIdx[0] - CONTEXT);
  let gEnd = Math.min(tagged.length - 1, changeIdx[0] + CONTEXT);
  for (let k = 1; k < changeIdx.length; k++) {
    const c = changeIdx[k];
    if (c - gEnd <= CONTEXT + 1) {
      gEnd = Math.min(tagged.length - 1, c + CONTEXT);
    } else {
      groups.push([gStart, gEnd]);
      gStart = Math.max(0, c - CONTEXT);
      gEnd = Math.min(tagged.length - 1, c + CONTEXT);
    }
  }
  groups.push([gStart, gEnd]);

  const result: string[] = [];
  for (const [s, e] of groups) {
    const slice = tagged.slice(s, e + 1);
    const oldCount = slice.filter((t) => t.op.type !== 'add').length;
    const newCount = slice.filter((t) => t.op.type !== 'del').length;
    const oldStart = slice.find((t) => t.op.type !== 'add')?.oldLine ?? 0;
    const newStart = slice.find((t) => t.op.type !== 'del')?.newLine ?? 0;
    result.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const t of slice) {
      const prefix = t.op.type === 'keep' ? ' ' : t.op.type === 'del' ? '-' : '+';
      result.push(prefix + t.op.line);
    }
  }
  return result;
}

/** A single hunk in appliable form: header plus ' '/'-'/'+' prefixed lines. */
export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: string[];
}

/** Structured hunks between two file versions (used by `git add -p`). */
export function computeHunks(oldContent: string, newContent: string): PatchHunk[] {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const ops = lcsOps(oldLines, newLines);

  let oldNo = 0;
  let newNo = 0;
  const tagged = ops.map((op) => {
    const t = { op, oldLine: 0, newLine: 0 };
    if (op.type !== 'add') t.oldLine = ++oldNo;
    if (op.type !== 'del') t.newLine = ++newNo;
    return t;
  });
  const changeIdx = tagged
    .map((t, idx) => (t.op.type === 'keep' ? -1 : idx))
    .filter((x) => x >= 0);
  if (changeIdx.length === 0) return [];

  const groups: Array<[number, number]> = [];
  let gStart = Math.max(0, changeIdx[0] - CONTEXT);
  let gEnd = Math.min(tagged.length - 1, changeIdx[0] + CONTEXT);
  for (let k = 1; k < changeIdx.length; k++) {
    const c = changeIdx[k];
    if (c - gEnd <= CONTEXT + 1) {
      gEnd = Math.min(tagged.length - 1, c + CONTEXT);
    } else {
      groups.push([gStart, gEnd]);
      gStart = Math.max(0, c - CONTEXT);
      gEnd = Math.min(tagged.length - 1, c + CONTEXT);
    }
  }
  groups.push([gStart, gEnd]);

  return groups.map(([s, e]) => {
    const slice = tagged.slice(s, e + 1);
    const oldCount = slice.filter((t) => t.op.type !== 'add').length;
    const newCount = slice.filter((t) => t.op.type !== 'del').length;
    const oldStart = slice.find((t) => t.op.type !== 'add')?.oldLine ?? 0;
    const newStart = slice.find((t) => t.op.type !== 'del')?.newLine ?? 0;
    return {
      oldStart,
      oldCount,
      newStart,
      newCount,
      header: `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`,
      lines: slice.map(
        (t) => (t.op.type === 'keep' ? ' ' : t.op.type === 'del' ? '-' : '+') + t.op.line,
      ),
    };
  });
}

/**
 * Applies the selected hunks (ascending oldStart order) to oldContent,
 * producing the intermediate version `git add -p` would stage. Game files end
 * with a trailing newline; that convention is preserved here.
 */
export function applyHunks(oldContent: string, selected: PatchHunk[]): string {
  const oldLines = splitLines(oldContent);
  const out: string[] = [];
  let cursor = 0;
  for (const h of [...selected].sort((a, b) => a.oldStart - b.oldStart)) {
    const startIdx = h.oldStart === 0 ? 0 : h.oldStart - 1;
    while (cursor < startIdx && cursor < oldLines.length) {
      out.push(oldLines[cursor]);
      cursor += 1;
    }
    for (const line of h.lines) {
      const t = line.charAt(0);
      if (t === ' ') {
        out.push(oldLines[cursor]);
        cursor += 1;
      } else if (t === '-') {
        cursor += 1;
      } else {
        out.push(line.slice(1));
      }
    }
  }
  while (cursor < oldLines.length) {
    out.push(oldLines[cursor]);
    cursor += 1;
  }
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

export function buildFileDiff(input: FileDiffInput): string {
  const { oldContent, newContent, oldPath, newPath } = input;
  if (oldContent === newContent) return '';

  const oldOid = input.oldOid ?? '0000000';
  const newOid = input.newOid ?? '0000000';
  const header: string[] = [`diff --git a/${oldPath} b/${newPath}`];
  let body: string[];

  if (oldContent === null) {
    header.push('new file mode 100644', `index ${oldOid}..${newOid}`);
    header.push('--- /dev/null', `+++ b/${newPath}`);
    body = hunks([], splitLines(newContent ?? ''));
  } else if (newContent === null) {
    header.push('deleted file mode 100644', `index ${oldOid}..${newOid}`);
    header.push(`--- a/${oldPath}`, '+++ /dev/null');
    body = hunks(splitLines(oldContent), []);
  } else {
    header.push(`index ${oldOid}..${newOid} 100644`);
    header.push(`--- a/${oldPath}`, `+++ b/${newPath}`);
    body = hunks(splitLines(oldContent), splitLines(newContent));
  }
  return [...header, ...body].join('\n') + '\n';
}
