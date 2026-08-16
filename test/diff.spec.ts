import { describe, expect, it } from 'vitest';
import { buildFileDiff } from '@/engine/diff';

describe('buildFileDiff', () => {
  it('returns empty output for identical content', () => {
    expect(
      buildFileDiff({ oldContent: 'a\n', newContent: 'a\n', oldPath: 'f', newPath: 'f' }),
    ).toBe('');
  });

  it('formats a simple change with a real-shaped hunk', () => {
    const out = buildFileDiff({
      oldContent: 'one\ntwo\nthree\n',
      newContent: 'one\nTWO\nthree\n',
      oldPath: 'f.txt',
      newPath: 'f.txt',
      oldOid: 'aaa1111',
      newOid: 'bbb2222',
    });
    expect(out).toContain('diff --git a/f.txt b/f.txt');
    expect(out).toContain('index aaa1111..bbb2222 100644');
    expect(out).toContain('--- a/f.txt');
    expect(out).toContain('+++ b/f.txt');
    expect(out).toContain('@@ -1,3 +1,3 @@');
    expect(out).toContain('-two');
    expect(out).toContain('+TWO');
  });

  it('marks new files with /dev/null', () => {
    const out = buildFileDiff({
      oldContent: null,
      newContent: 'hi\n',
      oldPath: 'n.txt',
      newPath: 'n.txt',
    });
    expect(out).toContain('new file mode 100644');
    expect(out).toContain('--- /dev/null');
    expect(out).toContain('+++ b/n.txt');
    expect(out).toContain('@@ -0,0 +1 @@');
    expect(out).toContain('+hi');
  });

  it('marks deleted files', () => {
    const out = buildFileDiff({
      oldContent: 'bye\n',
      newContent: null,
      oldPath: 'd.txt',
      newPath: 'd.txt',
    });
    expect(out).toContain('deleted file mode 100644');
    expect(out).toContain('+++ /dev/null');
    expect(out).toContain('-bye');
  });

  it('counts appended lines correctly', () => {
    const out = buildFileDiff({
      oldContent: 'a\nb\n',
      newContent: 'a\nb\nc\n',
      oldPath: 'f',
      newPath: 'f',
    });
    expect(out).toContain('@@ -1,2 +1,3 @@');
    expect(out).toContain('+c');
  });

  it('splits distant changes into separate hunks', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    const newText = oldText.replace('line1', 'LINE1').replace('line18', 'LINE18');
    const out = buildFileDiff({ oldContent: oldText, newContent: newText, oldPath: 'f', newPath: 'f' });
    const hunkHeaders = out.split('\n').filter((l) => l.startsWith('@@'));
    expect(hunkHeaders.length).toBe(2);
  });
});
