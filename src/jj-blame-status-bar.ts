/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjService } from './jj-service';

interface BlameInfo {
    changeId: string;
    author: string;
    ago: string;
    description: string;
}

// Template produces one line per file line: changeId|author|ago|description\n
// Use | as separator; description may contain | so we join remainder back.
const ANNOTATE_TEMPLATE =
    'commit.change_id().short(12) ++ "|" ++ ' +
    'commit.author().name() ++ "|" ++ ' +
    'commit.author().timestamp().ago() ++ "|" ++ ' +
    'commit.description().first_line() ++ "\\n"';

const DEBOUNCE_MS = 150;

export class JjBlameStatusBarItem implements vscode.Disposable {
    private readonly _item: vscode.StatusBarItem;
    private readonly _subscriptions: vscode.Disposable[] = [];
    // Per-file annotation cache (invalidated on SCM status change)
    private readonly _cache = new Map<string, BlameInfo[]>();
    private _pendingUpdate: NodeJS.Timeout | undefined;
    private _currentChangeId: string | undefined;

    constructor(private readonly _jj: JjService) {
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this._item.command = 'jj-view.blame.openChange';

        this._subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this._scheduleUpdate()),
            vscode.window.onDidChangeTextEditorSelection(() => this._scheduleUpdate()),
        );

        this._scheduleUpdate();
    }

    /** Call this when the SCM state changes so stale annotations are evicted. */
    invalidateCache(): void {
        this._cache.clear();
        this._scheduleUpdate();
    }

    get currentChangeId(): string | undefined {
        return this._currentChangeId;
    }

    private _scheduleUpdate(): void {
        if (this._pendingUpdate !== undefined) {
            clearTimeout(this._pendingUpdate);
        }
        this._pendingUpdate = setTimeout(() => {
            this._pendingUpdate = undefined;
            this._update().catch(() => {});
        }, DEBOUNCE_MS);
    }

    private async _update(): Promise<void> {
        if (!vscode.workspace.getConfiguration('jj-view').get<boolean>('blame.statusBarItem.enabled', true)) {
            this._item.hide();
            this._currentChangeId = undefined;
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            this._item.hide();
            this._currentChangeId = undefined;
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const lineIndex = editor.selection.active.line; // 0-based

        let annotations = this._cache.get(filePath);
        if (!annotations) {
            try {
                annotations = await this._fetchAnnotations(filePath);
                this._cache.set(filePath, annotations);
            } catch {
                this._item.hide();
                this._currentChangeId = undefined;
                return;
            }
        }

        const info = annotations[lineIndex];
        if (!info) {
            this._item.hide();
            this._currentChangeId = undefined;
            return;
        }

        this._currentChangeId = info.changeId;
        const desc = info.description || '(no description)';
        this._item.text = `$(git-commit) ${info.author}, ${info.ago} • ${desc}`;
        this._item.tooltip = new vscode.MarkdownString(
            `**${info.changeId}**\n\n${info.author}, ${info.ago}\n\n${desc}`,
        );
        this._item.show();
    }

    private async _fetchAnnotations(filePath: string): Promise<BlameInfo[]> {
        const output = await this._jj.annotate(filePath, ANNOTATE_TEMPLATE);
        return output.split('\n').map((line) => {
            if (!line) {
                return { changeId: '', author: '', ago: '', description: '' };
            }
            const parts = line.split('|');
            const changeId = parts[0] ?? '';
            const author = parts[1] ?? '';
            const ago = parts[2] ?? '';
            const description = parts.slice(3).join('|');
            return { changeId, author, ago, description };
        });
    }

    dispose(): void {
        if (this._pendingUpdate !== undefined) {
            clearTimeout(this._pendingUpdate);
        }
        this._item.dispose();
        for (const sub of this._subscriptions) {
            sub.dispose();
        }
    }
}
