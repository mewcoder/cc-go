/*
 * Selected value-type semantics adapted from Visual Studio Code.
 * Copyright (c) Microsoft Corporation. All rights reserved.
 *
 * MIT License
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
'use strict';

const { URI, Utils } = require('vscode-uri');
const Uri = URI;
Uri.joinPath = Utils.joinPath;

function enumValues(values) {
  const result = { ...values };
  for (const [name, value] of Object.entries(values)) result[value] = name;
  return Object.freeze(result);
}

const ExtensionMode = enumValues({ Production: 1, Development: 2, Test: 3 });
const ExtensionKind = enumValues({ UI: 1, Workspace: 2 });
const UIKind = enumValues({ Desktop: 1, Web: 2 });
const ViewColumn = enumValues({ Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 });
const ConfigurationTarget = enumValues({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });
const StatusBarAlignment = enumValues({ Left: 1, Right: 2 });
const ProgressLocation = enumValues({ SourceControl: 1, Window: 10, Notification: 15 });
const EndOfLine = enumValues({ LF: 1, CRLF: 2 });
const DiagnosticSeverity = enumValues({ Error: 0, Warning: 1, Information: 2, Hint: 3 });
const TextEditorRevealType = enumValues({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 });
const TextDocumentChangeReason = enumValues({ Undo: 1, Redo: 2 });
const CommentThreadState = enumValues({ Unresolved: 0, Resolved: 1 });
const CommentThreadCollapsibleState = enumValues({ Collapsed: 0, Expanded: 1 });
const NotebookEditorRevealType = enumValues({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 });
const NotebookCellKind = enumValues({ Markup: 1, Code: 2 });
const FileType = enumValues({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });
const FileChangeType = enumValues({ Changed: 1, Created: 2, Deleted: 3 });

class Disposable {
  constructor(callOnDispose) {
    if (callOnDispose !== undefined && typeof callOnDispose !== 'function') throw new TypeError('Expected a dispose callback');
    this._callOnDispose = callOnDispose;
  }
  dispose() {
    const callback = this._callOnDispose;
    this._callOnDispose = undefined;
    return callback?.();
  }
  static from(...disposables) {
    return new Disposable(() => {
      const errors = [];
      for (const item of disposables) {
        try { item?.dispose?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Error disposing resources');
    });
  }
}

function track(disposable, disposables) {
  if (disposables) disposables.push(disposable);
  return disposable;
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this._queue = [];
    this._firing = false;
    this._disposed = false;
    // An event can be saved and subscribed without binding the emitter.
    this.event = (listener, thisArgs, disposables) => {
      if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
      const subscription = { listener, thisArgs, active: !this._disposed };
      if (subscription.active) this._listeners.add(subscription);
      return track(new Disposable(() => {
        subscription.active = false;
        this._listeners.delete(subscription);
      }), disposables);
    };
  }
  fire(value) {
    if (this._disposed) return;
    for (const subscription of this._listeners) this._queue.push([subscription, value]);
    if (this._firing) return;
    this._firing = true;
    try {
      for (let i = 0; i < this._queue.length; i++) {
        const [subscription, data] = this._queue[i];
        if (!subscription.active) continue;
        try { subscription.listener.call(subscription.thisArgs, data); }
        catch (error) {
          // Match event isolation without silently hiding extension exceptions.
          queueMicrotask(() => { throw error; });
        }
      }
    } finally {
      this._queue.length = 0;
      this._firing = false;
    }
  }
  dispose() {
    this._disposed = true;
    for (const subscription of this._listeners) subscription.active = false;
    this._listeners.clear();
    this._queue.length = 0;
  }
}

class CancellationTokenSource {
  constructor(parent) {
    this._requested = false;
    this._disposed = false;
    this._emitter = new EventEmitter();
    const source = this;
    this._token = Object.freeze({
      get isCancellationRequested() { return source._requested; },
      onCancellationRequested(listener, thisArgs, disposables) {
        if (typeof listener !== 'function') throw new TypeError('Cancellation listener must be a function');
        if (source._requested) {
          const timer = setTimeout(() => listener.call(thisArgs, undefined), 0);
          return track(new Disposable(() => clearTimeout(timer)), disposables);
        }
        return source._emitter.event(listener, thisArgs, disposables);
      },
    });
    if (parent) {
      if (parent.isCancellationRequested) this.cancel();
      else this._parentListener = parent.onCancellationRequested(() => this.cancel());
    }
  }
  get token() { return this._token; }
  cancel() {
    if (this._requested || this._disposed) return;
    this._requested = true;
    this._emitter.fire(undefined);
    this._emitter.dispose();
  }
  dispose(cancel = false) {
    if (this._disposed) return;
    if (cancel) this.cancel();
    this._disposed = true;
    this._emitter.dispose();
    this._parentListener?.dispose();
    this._parentListener = undefined;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    if (typeof pattern !== 'string') throw new TypeError('RelativePattern requires a string pattern');
    if (typeof base === 'string') this.baseUri = Uri.file(base);
    else if (Uri.isUri(base)) this.baseUri = base;
    else if (base && Uri.isUri(base.uri)) this.baseUri = base.uri;
    else throw new TypeError('RelativePattern requires a path, URI or workspace folder');
    this.pattern = pattern;
  }
  get base() { return this._base; }
  set base(value) {
    if (typeof value !== 'string') throw new TypeError('Expected a base path');
    this._base = value;
    this._baseUri = Uri.file(value);
  }
  get baseUri() { return this._baseUri; }
  set baseUri(value) {
    if (!Uri.isUri(value)) throw new TypeError('Expected a base URI');
    this._baseUri = value;
    this._base = value.fsPath;
  }
  toJSON() { return { pattern: this.pattern, base: this.base, baseUri: this.baseUri.toJSON() }; }
}

function index(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

class Position {
  constructor(line, character) {
    this._line = index(line, 'line');
    this._character = index(character, 'character');
  }
  get line() { return this._line; }
  get character() { return this._character; }
  static isPosition(value) {
    return !!value && Number.isInteger(value.line) && value.line >= 0 && Number.isInteger(value.character) && value.character >= 0;
  }
  static of(value) {
    if (!Position.isPosition(value)) throw new TypeError('Expected a Position');
    return value instanceof Position ? value : new Position(value.line, value.character);
  }
  compareTo(other) {
    other = Position.of(other);
    return Math.sign(this.line - other.line) || Math.sign(this.character - other.character);
  }
  isBefore(other) { return this.compareTo(other) < 0; }
  isBeforeOrEqual(other) { return this.compareTo(other) <= 0; }
  isAfter(other) { return this.compareTo(other) > 0; }
  isAfterOrEqual(other) { return this.compareTo(other) >= 0; }
  isEqual(other) { return Position.isPosition(other) && this.line === other.line && this.character === other.character; }
  translate(lineDelta = 0, characterDelta = 0) {
    if (lineDelta === null || characterDelta === null) throw new TypeError('Invalid position delta');
    if (typeof lineDelta === 'object') ({ lineDelta = 0, characterDelta = 0 } = lineDelta);
    if (!Number.isInteger(lineDelta) || !Number.isInteger(characterDelta)) throw new TypeError('Expected integer position deltas');
    return this.with(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character) {
    if (line === null || character === null) throw new TypeError('Invalid position');
    if (typeof line === 'object') ({ line = this.line, character = this.character } = line);
    if (line === this.line && character === this.character) return this;
    return new Position(line, character);
  }
  toJSON() { return { line: this.line, character: this.character }; }
}

class Range {
  constructor(start, end, endLine, endCharacter) {
    if (typeof start === 'number') {
      start = new Position(start, end);
      end = new Position(endLine, endCharacter);
    } else {
      start = Position.of(start);
      end = Position.of(end);
    }
    [this._start, this._end] = start.isBefore(end) ? [start, end] : [end, start];
  }
  static isRange(value) { return !!value && Position.isPosition(value.start) && Position.isPosition(value.end); }
  static of(value) {
    if (!Range.isRange(value)) throw new TypeError('Expected a Range');
    return value instanceof Range ? value : new Range(value.start, value.end);
  }
  get start() { return this._start; }
  get end() { return this._end; }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(value) {
    if (Range.isRange(value)) return this.contains(value.start) && this.contains(value.end);
    return Position.isPosition(value) && this.start.isBeforeOrEqual(value) && this.end.isAfterOrEqual(value);
  }
  isEqual(other) { return Range.isRange(other) && this.start.isEqual(other.start) && this.end.isEqual(other.end); }
  intersection(other) {
    other = Range.of(other);
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other) {
    other = Range.of(other);
    if (this.contains(other)) return this;
    if (other.contains(this)) return other;
    return new Range(this.start.isBefore(other.start) ? this.start : other.start,
      this.end.isAfter(other.end) ? this.end : other.end);
  }
  with(start = this.start, end = this.end) {
    if (start === null || end === null) throw new TypeError('Invalid range');
    if (!Position.isPosition(start)) ({ start = this.start, end = this.end } = start);
    if (this.start.isEqual(start) && this.end.isEqual(end)) return this;
    return new Range(start, end);
  }
  toJSON() { return [this.start, this.end]; }
}

class Selection extends Range {
  constructor(anchor, active, activeLine, activeCharacter) {
    if (typeof anchor === 'number') {
      anchor = new Position(anchor, active);
      active = new Position(activeLine, activeCharacter);
    } else {
      anchor = Position.of(anchor);
      active = Position.of(active);
    }
    super(anchor, active);
    this._anchor = anchor;
    this._active = active;
  }
  static isSelection(value) {
    return Range.isRange(value) && Position.isPosition(value.anchor) && Position.isPosition(value.active) && typeof value.isReversed === 'boolean';
  }
  get anchor() { return this._anchor; }
  get active() { return this._active; }
  get isReversed() { return this.anchor.isEqual(this.end); }
  toJSON() { return { start: this.start, end: this.end, active: this.active, anchor: this.anchor }; }
}

class ThemeColor {
  constructor(id) {
    if (typeof id !== 'string') throw new TypeError('ThemeColor requires an id');
    this.id = id;
  }
}
class ThemeIcon {
  constructor(id, color) {
    if (typeof id !== 'string') throw new TypeError('ThemeIcon requires an id');
    this.id = id;
    this.color = color;
  }
  static isThemeIcon(value) { return !!value && typeof value.id === 'string'; }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class NotebookCellOutputItem {
  constructor(data, mime) {
    if (!(data instanceof Uint8Array)) throw new TypeError('Notebook output data must be Uint8Array');
    const match = typeof mime === 'string' && /^([^\s/;]+)\/([^\s/;]+)(;.*)?$/.exec(mime);
    if (!match) throw new TypeError('Notebook output requires a type/subtype MIME');
    this.data = data;
    this.mime = `${match[1].toLowerCase()}/${match[2].toLowerCase()}${match[3] || ''}`;
  }
  static isNotebookCellOutputItem(value) { return !!value && typeof value.mime === 'string' && value.data instanceof Uint8Array; }
  static bytes(value, mime = 'application/octet-stream') { return new NotebookCellOutputItem(value, mime); }
  static text(value, mime = 'text/plain') { return new NotebookCellOutputItem(new TextEncoder().encode(String(value)), mime); }
  static json(value, mime = 'text/x-json') { return NotebookCellOutputItem.text(JSON.stringify(value, undefined, '\t'), mime); }
  static error(error) {
    return NotebookCellOutputItem.json({ name: error.name, message: error.message, stack: error.stack }, 'application/vnd.code.notebook.error');
  }
}

class NotebookCellData {
  constructor(kind, value, languageId, mime, outputs = [], metadata, executionSummary) {
    if (![NotebookCellKind.Markup, NotebookCellKind.Code].includes(kind)) throw new TypeError('Invalid notebook cell kind');
    if (typeof value !== 'string' || typeof languageId !== 'string') throw new TypeError('Notebook cell value and languageId must be strings');
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
    this.mime = mime;
    this.outputs = outputs;
    this.metadata = metadata;
    this.executionSummary = executionSummary;
  }
}

class NotebookRange {
  constructor(start, end) {
    index(start, 'start');
    index(end, 'end');
    this._start = Math.min(start, end);
    this._end = Math.max(start, end);
  }
  static isNotebookRange(value) { return !!value && Number.isInteger(value.start) && value.start >= 0 && Number.isInteger(value.end) && value.end >= 0; }
  get start() { return this._start; }
  get end() { return this._end; }
  get isEmpty() { return this.start === this.end; }
  with({ start = this.start, end = this.end }) {
    return start === this.start && end === this.end ? this : new NotebookRange(start, end);
  }
}

class NotebookEdit {
  constructor(range, newCells) {
    if (!NotebookRange.isNotebookRange(range) || !Array.isArray(newCells)) throw new TypeError('Invalid notebook edit');
    this.range = range;
    this.newCells = newCells;
  }
  static isNotebookCellEdit(value) { return !!value && NotebookRange.isNotebookRange(value.range) && Array.isArray(value.newCells); }
  static replaceCells(range, newCells) { return new NotebookEdit(range, newCells); }
  static insertCells(index, newCells) { return new NotebookEdit(new NotebookRange(index, index), newCells); }
  static deleteCells(range) { return new NotebookEdit(range, []); }
  static updateCellMetadata(index, newMetadata) {
    const edit = NotebookEdit.insertCells(index, []);
    edit.newCellMetadata = newMetadata;
    return edit;
  }
  static updateNotebookMetadata(newMetadata) {
    const edit = NotebookEdit.insertCells(0, []);
    edit.newNotebookMetadata = newMetadata;
    return edit;
  }
}

class FileSystemError extends Error {
  constructor(messageOrUri, code = 'Unknown') {
    super(Uri.isUri(messageOrUri) ? messageOrUri.toString(true) : messageOrUri);
    this.code = code;
    const providerCode = { FileNotFound: 'EntryNotFound', FileExists: 'EntryExists', FileNotADirectory: 'EntryNotADirectory', FileIsADirectory: 'EntryIsADirectory' }[code] || code;
    this.name = `${providerCode} (FileSystemError)`;
  }
  static FileExists(value) { return new FileSystemError(value, 'FileExists'); }
  static FileNotFound(value) { return new FileSystemError(value, 'FileNotFound'); }
  static FileNotADirectory(value) { return new FileSystemError(value, 'FileNotADirectory'); }
  static FileIsADirectory(value) { return new FileSystemError(value, 'FileIsADirectory'); }
  static NoPermissions(value) { return new FileSystemError(value, 'NoPermissions'); }
  static Unavailable(value) { return new FileSystemError(value, 'Unavailable'); }
}

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
  static isTextEdit(value) { return !!value && Range.isRange(value.range) && typeof value.newText === 'string'; }
  static replace(range, newText) { return new TextEdit(range, newText); }
  static insert(position, newText) { return new TextEdit(new Range(position, position), newText); }
  static delete(range) { return new TextEdit(range, ''); }
  static setEndOfLine(eol) {
    const edit = new TextEdit(new Range(0, 0, 0, 0), '');
    edit.newEol = eol;
    return edit;
  }
  get range() { return this._range; }
  set range(value) { this._range = Range.of(value); }
  get newText() { return this._newText || ''; }
  set newText(value) {
    if (value !== null && typeof value !== 'string') throw new TypeError('TextEdit newText must be a string or null');
    this._newText = value;
  }
  get newEol() { return this._newEol; }
  set newEol(value) {
    if (value !== undefined && value !== EndOfLine.LF && value !== EndOfLine.CRLF) throw new TypeError('Invalid end-of-line value');
    this._newEol = value;
  }
  toJSON() { return { range: this.range, newText: this.newText, newEol: this.newEol }; }
}

class WorkspaceEdit {
  constructor() { this._edits = []; }
  // The host must inspect all entries before applying anything; entries() is
  // intentionally text-only, just like VS Code, not a license to drop file edits.
  _allEntries() { return this._edits; }
  renameFile(from, to, options, metadata) { this._edits.push({ _type: 1, from, to, options, metadata }); }
  createFile(uri, options, metadata) { this._edits.push({ _type: 1, from: undefined, to: uri, options, metadata }); }
  deleteFile(uri, options, metadata) { this._edits.push({ _type: 1, from: uri, to: undefined, options, metadata }); }
  replace(uri, range, newText, metadata) { this._edits.push({ _type: 2, uri, edit: new TextEdit(range, newText), metadata }); }
  insert(uri, position, newText, metadata) { this.replace(uri, new Range(position, position), newText, metadata); }
  delete(uri, range, metadata) { this.replace(uri, range, '', metadata); }
  has(uri) { return this._edits.some(item => item._type === 2 && item.uri.toString() === uri.toString()); }
  set(uri, edits) {
    if (edits == null) {
      this._edits = this._edits.filter(item => item._type === 1 || item.uri.toString() !== uri.toString());
      return;
    }
    if (!Array.isArray(edits)) throw new TypeError('WorkspaceEdit.set requires an array');
    const additions = [];
    for (const item of edits) {
      if (!item) continue;
      const [edit, metadata] = Array.isArray(item) ? item : [item, undefined];
      if (NotebookEdit.isNotebookCellEdit(edit)) {
        if (edit.newCellMetadata) additions.push({ _type: 3, uri, metadata, edit: { editType: 3, index: edit.range.start, metadata: edit.newCellMetadata } });
        else if (edit.newNotebookMetadata) additions.push({ _type: 3, uri, metadata, edit: { editType: 5, metadata: edit.newNotebookMetadata } });
        else if (edit.range.start !== edit.range.end || edit.newCells.length) {
          additions.push({ _type: 5, uri, metadata, index: edit.range.start, count: edit.range.end - edit.range.start, cells: edit.newCells });
        }
      } else if (TextEdit.isTextEdit(edit)) additions.push({ _type: 2, uri, edit, metadata });
      else throw new TypeError('Unsupported WorkspaceEdit entry (only TextEdit and NotebookEdit are implemented)');
    }
    this._edits.push(...additions);
  }
  get(uri) { return this._edits.filter(item => item._type === 2 && item.uri.toString() === uri.toString()).map(item => item.edit); }
  entries() {
    const result = new Map();
    for (const item of this._edits) {
      if (item._type !== 2) continue;
      const key = item.uri.toString();
      if (!result.has(key)) result.set(key, [item.uri, []]);
      result.get(key)[1].push(item.edit);
    }
    return [...result.values()];
  }
  get size() { return this.entries().length; }
  toJSON() { return this.entries(); }
}

class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }

module.exports = {
  Disposable, EventEmitter, Uri, RelativePattern, Position, Range, Selection, ThemeColor, ThemeIcon,
  NotebookCellOutputItem, NotebookCellData, NotebookCellKind, NotebookRange, NotebookEdit,
  CancellationTokenSource, FileSystemError, FileType, FileChangeType, TextEdit, WorkspaceEdit,
  TabInputWebview, TabInputText, TabInputTextDiff, ExtensionMode, ExtensionKind, UIKind, ViewColumn,
  ConfigurationTarget, StatusBarAlignment, ProgressLocation, EndOfLine, DiagnosticSeverity,
  TextEditorRevealType, TextDocumentChangeReason, CommentThreadState, CommentThreadCollapsibleState,
  NotebookEditorRevealType,
};
