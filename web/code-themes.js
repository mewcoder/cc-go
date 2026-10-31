'use strict';

(() => {
  const nonce = typeof document !== 'undefined' ? document.currentScript?.nonce : '';
  // Monarch emits token names rather than TextMate scopes. Keep the translation
  // here so vendor theme data remains intact and Monaco keeps its own tokenizer.
  const scopes = {
    comment: ['comment'], 'comment.doc': ['comment.block.documentation', 'comment'],
    string: ['string'], 'string.escape': ['constant.character.escape'],
    'string.invalid': ['invalid.illegal'], 'string.key': ['support.type.property-name', 'variable.other.property'],
    number: ['constant.numeric'], 'number.hex': ['constant.numeric.hex', 'constant.numeric'],
    regexp: ['string.regexp'], 'regexp.escape': ['constant.character.escape'],
    keyword: ['keyword', 'storage.type'], 'keyword.control': ['keyword.control', 'keyword'],
    'keyword.flow': ['keyword.control', 'keyword'], 'keyword.json': ['constant.language'],
    'keyword.operator': ['keyword.operator'], 'keyword.other': ['keyword.other', 'keyword'],
    operator: ['keyword.operator'], delimiter: ['punctuation'],
    'delimiter.bracket': ['punctuation.section', 'punctuation'],
    'delimiter.square': ['punctuation.section.brackets', 'punctuation'],
    'delimiter.parenthesis': ['punctuation.section.parens', 'punctuation'],
    identifier: ['variable.other.readwrite', 'variable'], variable: ['variable'],
    'variable.predefined': ['variable.language'], 'variable.parameter': ['variable.parameter', 'variable'],
    constant: ['constant.language', 'constant'], type: ['entity.name.type', 'support.type'],
    'type.identifier': ['entity.name.type', 'support.type'],
    'type.predefined': ['support.type', 'storage.type'],
    predefined: ['support.function', 'support'], function: ['entity.name.function', 'support.function'],
    'function.predefined': ['support.function'], annotation: ['storage.type.annotation', 'entity.name.tag'],
    tag: ['entity.name.tag'], 'tag.id': ['entity.other.attribute-name.id'],
    'tag.class': ['entity.other.attribute-name.class'],
    'attribute.name': ['entity.other.attribute-name'], 'attribute.value': ['string'],
    metatag: ['meta.tag', 'entity.name.tag'], 'metatag.content': ['string'],
    'key.yaml': ['entity.name.tag', 'variable.other.property'],
    'string.yaml': ['string'], 'boolean.yaml': ['constant.language.boolean', 'constant.language'],
    'operators.sql': ['keyword.operator'], 'predefined.sql': ['support.function'],
    invalid: ['invalid.illegal', 'invalid'], emphasis: ['markup.italic'], strong: ['markup.bold'],
  };

  function tokenStyle(theme, candidates) {
    for (const candidate of candidates) {
      const result = {};
      const scores = {};
      for (const rule of theme.tokenColors ?? []) {
        const selectors = Array.isArray(rule.scope) ? rule.scope : String(rule.scope ?? '').split(',');
        for (const raw of selectors) {
          const scope = raw.trim();
          if (!scope || (candidate !== scope && !candidate.startsWith(scope + '.'))) continue;
          for (const key of ['foreground', 'fontStyle']) {
            const value = rule.settings?.[key];
            if (value !== undefined && scope.length >= (scores[key] ?? -1)) {
              result[key] = value;
              scores[key] = scope.length;
            }
          }
        }
      }
      if (Object.keys(result).length) return result;
    }
    return {};
  }

  function convert(theme) {
    const dark = theme.type === 'dark';
    const hex = value => /^#[\da-f]{3,4}$/i.test(value)
      ? '#' + value.slice(1).split('').map(char => char + char).join('') : value;
    const colors = Object.fromEntries(Object.entries(theme.colors ?? {})
      .filter(([, value]) => typeof value === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value))
      .map(([key, value]) => [key, hex(value)]));
    colors['editor.background'] ??= dark ? '#1e1e1e' : '#ffffff';
    colors['editor.foreground'] ??= theme.fg ?? colors.foreground ?? (dark ? '#d4d4d4' : '#202020');
    for (const [change, resource] of [['inserted', 'added'], ['removed', 'deleted']]) {
      const scope = tokenStyle(theme, ['markup.' + (change === 'removed' ? 'deleted' : 'inserted')]).foreground;
      const accent = colors[`gitDecoration.${resource}ResourceForeground`]
        ?? colors[`editorGutter.${resource}Background`]
        ?? (scope && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(scope) ? hex(scope) : colors['editor.foreground']);
      const line = `diffEditor.${change}LineBackground`, text = `diffEditor.${change}TextBackground`;
      const supplied = colors[line] ?? colors[text];
      // Keep supplied diff colors; derive missing colors from this palette's own change colors.
      colors[line] ??= supplied ?? accent.slice(0, 7) + '22';
      colors[text] ??= supplied ?? accent.slice(0, 7) + '44';
    }
    const rules = [{ token: '', foreground: colors['editor.foreground'].slice(1, 7), background: colors['editor.background'].slice(1, 7) }];
    for (const [token, candidates] of Object.entries(scopes)) {
      const style = tokenStyle(theme, candidates);
      if (style.foreground === 'white') style.foreground = '#ffffff';
      if (style.foreground === 'black') style.foreground = '#000000';
      if (style.foreground && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(style.foreground)) {
        style.foreground = hex(style.foreground).replace(/^#/, '').slice(0, 6);
      } else delete style.foreground;
      if (Object.keys(style).length) rules.push({ token, ...style });
    }
    return { base: dark ? 'vs-dark' : 'vs', inherit: true, rules, colors };
  }

  function create({ document, base, value, load = async id => {
    const response = await fetch(base + 'code-themes/' + encodeURIComponent(id) + '.json');
    if (!response.ok) throw Error('Could not load code theme: ' + id);
    return response.json();
  } }) {
    const loaded = new Map(), requests = new Map();
    let monaco, active, generation = 0, style;
    function register(id) {
      if (monaco && loaded.has(id)) monaco.defineTheme('cc-code-' + id, loaded.get(id));
    }
    function css(kind, id) {
      const data = loaded.get(id);
      if (!data) return '';
      const c = data.colors;
      const root = 'body.vscode-' + kind;
      return `${root} [class*="codeBlockWrapper_"] pre {
        background: ${c['editor.background']}; color: ${c['editor.foreground']};
      }
      ${root} [class*="codeBlockWrapper_"] pre code {
        color: inherit; background: transparent;
      }`;
    }
    function signal() {
      if (!document.body) return;
      style ??= document.createElement('style');
      if (nonce) style.nonce = nonce;
      style.textContent = css('light', active?.light) + css('dark', active?.dark);
      if (!style.isConnected) document.head.append(style);
      // The plugin observes class changes and uses the resolved name in its
      // token cache key, so existing code blocks and diffs re-render together.
      document.body.classList.toggle('cc-code-theme-refresh');
    }
    async function update(pair) {
      const current = ++generation;
      const next = pair ?? { id: 'default', light: 'default', dark: 'default' };
      try {
        await Promise.all([next.light, next.dark].filter(id => id && id !== 'default').map(id => {
          if (!requests.has(id)) requests.set(id, Promise.resolve().then(() => load(id)).then(theme => {
            loaded.set(id, convert(theme));
            register(id);
          }).catch(error => { requests.delete(id); throw error; }));
          return requests.get(id);
        }));
        if (current !== generation) return;
        active = next;
        signal();
      } catch (error) {
        console.error('CC Go code theme:', error);
      }
    }
    const ready = update(value);
    document.addEventListener('DOMContentLoaded', signal);
    return {
      ready, update,
      attach(api) {
        monaco = api;
        loaded.forEach((_, id) => register(id));
        return api.setTheme;
      },
      resolve(kind) {
        if (kind !== 'vs' && kind !== 'vs-dark') return kind;
        const id = kind === 'vs' ? active?.light : active?.dark;
        return monaco && loaded.has(id) ? 'cc-code-' + id : kind;
      },
    };
  }

  const api = { convert, tokenStyle, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.goCodeThemes = api;
})();
