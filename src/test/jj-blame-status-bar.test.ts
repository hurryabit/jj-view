/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JjService } from '../jj-service';
import { accessPrivate, createMock } from './test-utils';

// ── vscode mock ──────────────────────────────────────────────────────────────

/** Mutable state that tests can write to before each case. */
let mockActiveEditor:
    | {
          document: { uri: { scheme: string; fsPath: string } };
          selection: { active: { line: number } };
      }
    | undefined;

let mockConfigEnabled = true;

const mockItem = {
    text: '',
    tooltip: undefined as unknown,
    command: undefined as unknown,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
};

vi.mock('vscode', () => ({
    StatusBarAlignment: { Left: 1, Right: 2 },
    MarkdownString: class MockMarkdownString {
        constructor(public value: string) {}
    },
    window: {
        get activeTextEditor() {
            return mockActiveEditor;
        },
        createStatusBarItem: vi.fn(() => mockItem),
        onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: vi.fn((_key: string, defaultValue: unknown) => {
                if (_key === 'blame.statusBarItem.enabled') {
                    return mockConfigEnabled;
                }
                return defaultValue;
            }),
        })),
    },
}));

// Import under test AFTER mock
import { JjBlameStatusBarItem } from '../jj-blame-status-bar';

// ── helpers ───────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 150;

/** Advance timers past the debounce window and flush pending microtasks. */
async function flushDebounce() {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
}

function makeAnnotateOutput(...lines: string[]): string {
    return `${lines.join('\n')}\n`;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('JjBlameStatusBarItem', () => {
    let blameItem: JjBlameStatusBarItem;
    let jjMock: JjService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();

        // Reset shared state
        mockActiveEditor = undefined;
        mockConfigEnabled = true;

        // Reset the mock status bar item fields
        mockItem.text = '';
        mockItem.tooltip = undefined;

        jjMock = createMock<JjService>({
            annotate: vi.fn(),
        });

        blameItem = new JjBlameStatusBarItem(jjMock);
    });

    afterEach(async () => {
        blameItem.dispose();
        await vi.runAllTimersAsync();
        vi.useRealTimers();
    });

    // ── visibility ────────────────────────────────────────────────────────────

    it('hides when there is no active editor', async () => {
        mockActiveEditor = undefined;
        await flushDebounce();
        expect(mockItem.hide).toHaveBeenCalled();
        expect(mockItem.show).not.toHaveBeenCalled();
    });

    it('hides when the active editor is not a file (e.g. diff scheme)', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'jj-view', fsPath: '/some/file.ts' } },
            selection: { active: { line: 0 } },
        };
        await flushDebounce();
        expect(mockItem.hide).toHaveBeenCalled();
        expect(mockItem.show).not.toHaveBeenCalled();
    });

    it('hides when the feature is disabled via config', async () => {
        mockConfigEnabled = false;
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/some/file.ts' } },
            selection: { active: { line: 0 } },
        };
        await flushDebounce();
        expect(mockItem.hide).toHaveBeenCalled();
        expect(mockItem.show).not.toHaveBeenCalled();
    });

    it('hides when annotate throws (e.g. untracked file)', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/untracked.ts' } },
            selection: { active: { line: 0 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not tracked'));
        await flushDebounce();
        expect(mockItem.hide).toHaveBeenCalled();
        expect(mockItem.show).not.toHaveBeenCalled();
    });

    // ── display ───────────────────────────────────────────────────────────────

    it('shows blame info for the current line', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 1 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|3 days ago|First commit', 'xxyyzz998877|Bob|1 hour ago|Fix the bug'),
        );

        await flushDebounce();

        expect(mockItem.show).toHaveBeenCalled();
        expect(mockItem.text).toBe('$(git-commit) Bob, 1 hour ago • Fix the bug');
    });

    it('sets tooltip with change ID and full details', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 0 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|3 days ago|First commit'),
        );

        await flushDebounce();

        const tooltip = mockItem.tooltip as { value: string };
        expect(tooltip.value).toContain('aabbccdd1122');
        expect(tooltip.value).toContain('Alice');
        expect(tooltip.value).toContain('First commit');
    });

    it('falls back to "(no description)" for empty descriptions', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 0 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|3 days ago|'),
        );

        await flushDebounce();

        expect(mockItem.text).toContain('(no description)');
    });

    it('exposes the current change ID via the getter', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 0 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('deadbeef0000|Alice|1 day ago|Some change'),
        );

        await flushDebounce();

        expect(blameItem.currentChangeId).toBe('deadbeef0000');
    });

    it('clears currentChangeId when hiding', async () => {
        // First show something
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 0 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('deadbeef0000|Alice|1 day ago|Some change'),
        );
        await flushDebounce();
        expect(blameItem.currentChangeId).toBe('deadbeef0000');

        // Now hide by removing the editor
        mockActiveEditor = undefined;
        blameItem.invalidateCache();
        await flushDebounce();

        expect(blameItem.currentChangeId).toBeUndefined();
    });

    // ── parsing ───────────────────────────────────────────────────────────────

    it('handles pipe characters in commit descriptions', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 0 } },
        };
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|2 hours ago|feat: add a|b toggle'),
        );

        await flushDebounce();

        expect(mockItem.text).toContain('feat: add a|b toggle');
    });

    it('handles trailing blank line from annotate output gracefully', async () => {
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/foo.ts' } },
            selection: { active: { line: 0 } },
        };
        // Output ends with \n so split produces an empty string at the end;
        // that should not crash or surface as a valid annotation entry.
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue('aabbccdd1122|Alice|2 hours ago|Good commit\n');

        await flushDebounce();

        expect(mockItem.show).toHaveBeenCalled();
        expect(mockItem.text).toContain('Good commit');
    });

    // ── caching ───────────────────────────────────────────────────────────────

    it('calls annotate only once per file across multiple cursor moves', async () => {
        const filePath = '/repo/foo.ts';
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput(
                'aabbccdd1122|Alice|3 days ago|Line 1 commit',
                'xxyyzz998877|Bob|1 hour ago|Line 2 commit',
            ),
        );

        // Initial annotation fetch for line 0
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: filePath } },
            selection: { active: { line: 0 } },
        };
        blameItem.invalidateCache();
        await flushDebounce();
        expect(jjMock.annotate).toHaveBeenCalledTimes(1);
        expect(mockItem.text).toContain('Line 1 commit');

        // Move cursor to line 1 — simulate selection change without clearing the cache
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: filePath } },
            selection: { active: { line: 1 } },
        };
        accessPrivate(blameItem, '_scheduleUpdate').call(blameItem);
        await flushDebounce();

        // annotate should NOT have been called again — cache hit
        expect(jjMock.annotate).toHaveBeenCalledTimes(1);
        expect(mockItem.text).toContain('Line 2 commit');
    });

    it('re-fetches annotations after invalidateCache()', async () => {
        const filePath = '/repo/foo.ts';
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|3 days ago|Initial'),
        );

        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: filePath } },
            selection: { active: { line: 0 } },
        };
        await flushDebounce();
        expect(jjMock.annotate).toHaveBeenCalledTimes(1);

        // Invalidate (simulates SCM status change)
        blameItem.invalidateCache();
        await flushDebounce();
        expect(jjMock.annotate).toHaveBeenCalledTimes(2);
    });

    it('caches annotations independently per file', async () => {
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|1 day ago|Some commit'),
        );

        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/a.ts' } },
            selection: { active: { line: 0 } },
        };
        blameItem.invalidateCache();
        await flushDebounce();

        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: '/repo/b.ts' } },
            selection: { active: { line: 0 } },
        };
        blameItem.invalidateCache();
        await flushDebounce();

        // Each file triggers its own annotate call
        expect(jjMock.annotate).toHaveBeenCalledTimes(2);
        expect(jjMock.annotate).toHaveBeenCalledWith('/repo/a.ts', expect.any(String));
        expect(jjMock.annotate).toHaveBeenCalledWith('/repo/b.ts', expect.any(String));
    });

    // ── debounce ──────────────────────────────────────────────────────────────

    it('debounces rapid updates into a single annotate call', async () => {
        const filePath = '/repo/foo.ts';
        (jjMock.annotate as ReturnType<typeof vi.fn>).mockResolvedValue(
            makeAnnotateOutput('aabbccdd1122|Alice|3 days ago|Commit'),
        );

        // Fire five rapid invalidations (simulating fast cursor movement)
        mockActiveEditor = {
            document: { uri: { scheme: 'file', fsPath: filePath } },
            selection: { active: { line: 0 } },
        };
        for (let i = 0; i < 5; i++) {
            blameItem.invalidateCache();
            await vi.advanceTimersByTimeAsync(50); // less than DEBOUNCE_MS
        }

        // Now let the debounce fire
        await vi.advanceTimersByTimeAsync(200);

        expect(jjMock.annotate).toHaveBeenCalledTimes(1);
    });

    // ── disposal ──────────────────────────────────────────────────────────────

    it('disposes the status bar item and clears the pending timer', () => {
        blameItem.dispose();
        expect(mockItem.dispose).toHaveBeenCalled();
        // No timer should fire after dispose
        expect(() => vi.runAllTimers()).not.toThrow();
    });
});
