/**
 * dsh-session-export — browser half.
 *
 * One surface: `conversation.chat.commandview`, keyed by the command name
 * `export-session`. The default card prints the host's result text as a
 * paragraph; this renderer turns each exported path into a row you can click
 * to copy and open in the right sidebar.
 *
 * Everything that touches disk lives in the host half. This file only reads
 * the result text the host already returned, and hands an address to
 * `ctx.sidebarRight.openResource`, which the shipped document preview claims.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-export',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useMemo = React.useMemo;

    var NS = 'dsh-session-export';
    var SLOT = 'conversation.chat.commandview';
    var COMMAND_NAME = 'export-session';
    var FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

    /* --------------------------------------------------------- dictionaries */

    var EN = {
      'card.exported': 'Exported {count}',
      'card.exportedOne': 'Exported 1 file',
      'card.failed': 'Export failed',
      'card.running': 'Exporting…',
      'card.copy': 'Copy path',
      'card.copied': 'Copied',
      'card.copyFailed': 'Could not copy',
      'card.preview': 'Preview',
      'card.previewUnavailable': 'Preview unavailable',
      'card.pages': '{count} pages',
      'card.turns': '{count} turns',
      'card.bytes': '{size}',
      'card.noPath': 'No file path in the result.',
    };

    var ZH = {
      'card.exported': '已导出 {count} 个文件',
      'card.exportedOne': '已导出 1 个文件',
      'card.failed': '导出失败',
      'card.running': '正在导出…',
      'card.copy': '复制路径',
      'card.copied': '已复制',
      'card.copyFailed': '复制失败',
      'card.preview': '预览',
      'card.previewUnavailable': '预览不可用',
      'card.pages': '{count} 页',
      'card.turns': '{count} 轮',
      'card.bytes': '{size}',
      'card.noPath': '结果里没有文件路径。',
    };

    function detectLang() {
      try {
        var raw = window.localStorage.getItem('dsh.locale') || window.localStorage.getItem('dsh.language');
        if (typeof raw === 'string' && /^zh/iu.test(raw.replace(/"/gu, ''))) return 'zh';
      } catch (error) {
        /* storage may be blocked */
      }
      try {
        if (/^zh/iu.test(navigator.language || '')) return 'zh';
      } catch (error) {
        /* no navigator */
      }
      return 'en';
    }

    function format(text, params) {
      if (typeof text !== 'string') return '';
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/gu, function (whole, key) {
        var value = params[key];
        return value === undefined ? whole : String(value);
      });
    }

    function makeT(locale) {
      var bound = null;
      try {
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS);
      } catch (error) {
        bound = null;
      }
      var fallback = detectLang() === 'zh' ? ZH : EN;
      return function translate(key, params) {
        var text;
        if (bound !== null) {
          try {
            text = bound(key, params);
          } catch (error) {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text.length === 0 || text === key) text = fallback[key];
        if (typeof text !== 'string') text = key;
        return format(text, params);
      };
    }

    /* ------------------------------------------------------------- parsing */

    /*
     * The host summarizes one export per line:
     *
     *   /Users/x/Documents/a.pdf [pdf] 12345 bytes, 80 turns, 0 tool calls,
     *   0 results, 113 pages; no redactions
     *
     * Only the leading path and the format tag are structural; the tail is
     * free-form prose that grows with new counters, so it is captured whole
     * and mined for the two numbers worth showing.
     */
    var RESULT_LINE = /^(.+?) \[(markdown|text|html|jsonl|pdf)\] (\d+) bytes, (.+)$/u;
    var PAGES = /(\d+) pages/u;
    var TURNS = /(\d+) turns/u;

    function isAbsolutePath(value) {
      return /^\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value);
    }

    function splitPath(value) {
      var normalized = String(value).replace(/\\/gu, '/');
      var cut = normalized.lastIndexOf('/');
      if (cut < 0) return { dir: '', name: normalized };
      return { dir: normalized.slice(0, cut), name: normalized.slice(cut + 1) };
    }

    function bytesText(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return String(bytes) + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function parseExports(text) {
      var found = [];
      if (typeof text !== 'string' || text.length === 0) return found;
      var lines = text.split('\n');
      for (var index = 0; index < lines.length; index += 1) {
        var match = RESULT_LINE.exec(lines[index].trim());
        if (match === null) continue;
        var path = match[1];
        if (!isAbsolutePath(path)) continue;
        var parts = splitPath(path);
        found.push({
          path: path,
          dir: parts.dir,
          name: parts.name,
          format: match[2],
          bytes: Number(match[3]),
          detail: match[4],
        });
      }
      return found;
    }

    /** Build the address the file provider and the document preview share. */
    function fileAddress(sessionId, path) {
      var normalized = String(path).replace(/\\/gu, '/');
      var segments = normalized.split('/').map(encodeURIComponent).join('/');
      return FILE_ADDRESS_PREFIX + 'session/' + encodeURIComponent(String(sessionId)) + '/' + segments;
    }

    /* --------------------------------------------------------------- host IO */

    function serviceOf(ctx, name) {
      if (ctx === undefined || ctx === null) return undefined;
      try {
        if (typeof ctx.get === 'function') {
          var viaGet = ctx.get(name);
          if (viaGet !== undefined && viaGet !== null) return viaGet;
        }
      } catch (error) {
        /* the service is optional */
      }
      try {
        return ctx[name];
      } catch (error) {
        return undefined;
      }
    }

    function copyText(text) {
      return new Promise(function (resolve) {
        try {
          var clipboard = navigator.clipboard;
          if (clipboard && typeof clipboard.writeText === 'function') {
            clipboard.writeText(text).then(
              function () {
                resolve(true);
              },
              function () {
                resolve(false);
              },
            );
            return;
          }
        } catch (error) {
          /* fall through */
        }
        resolve(false);
      });
    }

    /* ----------------------------------------------------------------- style */

    var CSS = [
      '.dse-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;font-size:13px;',
      'color:var(--dsw-alias-label-primary);max-width:100%;min-width:0}',
      '.dse-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dse-glyph{flex:0 0 auto;width:14px;height:14px;display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
      '.dse-name{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dse-count{color:var(--dsw-alias-label-tertiary)}',
      '.dse-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;min-width:0}',
      '.dse-row{display:flex;align-items:center;gap:8px;min-width:0;border-radius:8px;padding:4px 6px;',
      'transition:background 120ms ease}',
      '.dse-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dse-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto;',
      'background:none;border:0;padding:0;margin:0;text-align:left;font:inherit;color:inherit;cursor:pointer}',
      '.dse-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
      '.dse-file{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.dse-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.dse-tag{flex:0 0 auto;font-size:10px;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dse-dir{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;',
      'font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dse-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dse-action{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);background:transparent;',
      'color:var(--dsw-alias-label-secondary);border-radius:7px;padding:2px 8px;font-size:11px;',
      'font-family:inherit;cursor:pointer;line-height:18px}',
      '.dse-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dse-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dse-flash{font-size:11px;color:var(--dsw-alias-state-success-primary);flex:0 0 auto}',
      '.dse-error{color:var(--dsw-alias-state-error-primary)}',
      '.dse-plain{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);',
      'font-size:12px;margin:0}',
      '.dse-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}',
    ].join('');

    function Styles() {
      return h('style', { 'data-dsh-session-export': '' }, CSS);
    }

    var GLYPH = h(
      'svg',
      { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
      h('path', {
        d: 'M4 1.5h5.2L13 5.3v9.2a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.2',
      }),
      h('path', { d: 'M9 1.7V5.5h3.8', fill: 'none', stroke: 'currentColor', strokeWidth: '1.2' }),
    );

    /* ------------------------------------------------------------- component */

    function FileRow(props) {
      var item = props.item;
      var t = props.t;
      var onCopy = props.onCopy;
      var onPreview = props.onPreview;
      var copied = props.copied;
      var canPreview = props.canPreview;

      var meta = useMemo(
        function () {
          var parts = [item.format, bytesText(item.bytes)];
          var pages = PAGES.exec(item.detail);
          if (pages !== null) parts.push(t('card.pages', { count: pages[1] }));
          var turns = TURNS.exec(item.detail);
          if (turns !== null) parts.push(t('card.turns', { count: turns[1] }));
          return parts.filter(function (part) {
            return typeof part === 'string' && part.length > 0;
          }).join(' · ');
        },
        [item, t],
      );

      var title = item.dir.length > 0 ? item.dir + '/' + item.name : item.name;

      return h(
        'li',
        { className: 'dse-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'dse-main',
            title: t('card.copy') + '\n' + title,
            onClick: function () {
              onCopy(item.path);
            },
          },
          h(
            'span',
            { className: 'dse-file' },
            h('span', { className: 'dse-title' }, item.name),
            h('span', { className: 'dse-tag' }, item.format),
          ),
          h('span', { className: 'dse-dir' }, item.dir),
          h('span', { className: 'dse-meta' }, meta),
        ),
        copied
          ? h('span', { className: 'dse-flash' }, t('card.copied'))
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dse-action',
            disabled: canPreview ? undefined : true,
            title: canPreview ? t('card.preview') : t('card.previewUnavailable'),
            onClick: function () {
              onPreview(item.path);
            },
          },
          t('card.preview'),
        ),
      );
    }

    function ExportCommandCard(props) {
      var node = props.node;
      var sessionId = props.sessionId;
      var t = props.t;
      var ctx = props.ctx;

      var outcome = node === undefined || node === null ? null : node.outcome;
      var running = outcome === undefined || outcome === null;
      var failed = outcome !== null && outcome !== undefined && outcome.kind === 'error';
      var text = outcome !== null && outcome !== undefined && typeof outcome.text === 'string' ? outcome.text : '';

      var files = useMemo(
        function () {
          if (failed) return [];
          try {
            return parseExports(text);
          } catch (error) {
            return [];
          }
        },
        [text, failed],
      );

      var copiedState = useState(null);
      var copied = copiedState[0];
      var setCopied = copiedState[1];

      var noticeState = useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      useEffect(
        function () {
          if (copied === null) return undefined;
          var timer = setTimeout(function () {
            setCopied(null);
          }, 1600);
          return function () {
            clearTimeout(timer);
          };
        },
        [copied],
      );

      useEffect(
        function () {
          if (notice === null) return undefined;
          var timer = setTimeout(function () {
            setNotice(null);
          }, 2400);
          return function () {
            clearTimeout(timer);
          };
        },
        [notice],
      );

      var onCopy = useCallback(
        function (path) {
          copyText(path).then(function (ok) {
            if (ok) {
              setCopied(path);
              return;
            }
            setNotice(t('card.copyFailed'));
          });
        },
        [t],
      );

      var onPreview = useCallback(
        function (path) {
          var sidebar = serviceOf(ctx, 'sidebarRight');
          if (sidebar === undefined || typeof sidebar.openResource !== 'function') {
            setNotice(t('card.previewUnavailable'));
            return;
          }
          try {
            sidebar.openResource(fileAddress(sessionId, path), { revealIfOpened: true });
          } catch (error) {
            setNotice(t('card.previewUnavailable'));
          }
        },
        [ctx, sessionId, t],
      );

      var canPreview = typeof sessionId === 'string' && sessionId.length > 0;

      var heading;
      if (running) heading = t('card.running');
      else if (failed) heading = t('card.failed');
      else if (files.length === 1) heading = t('card.exportedOne');
      else heading = t('card.exported', { count: String(files.length) });

      var head = h(
        'div',
        { className: 'dse-head' },
        h('span', { className: 'dse-glyph' }, GLYPH),
        h('span', { className: 'dse-name' }, COMMAND_NAME),
        h('span', { className: 'dse-count' }, '· ' + heading),
        notice !== null ? h('span', { className: 'dse-flash dse-error' }, notice) : null,
      );

      if (files.length === 0) {
        var body = failed || (outcome !== null && text.length > 0) ? text : t('card.noPath');
        return h(
          'div',
          { className: 'dse-card', 'data-state': failed ? 'error' : running ? 'running' : 'done' },
          h(Styles, null),
          head,
          h('p', { className: 'dse-plain' + (failed ? ' dse-error' : '') }, body),
        );
      }

      return h(
        'div',
        { className: 'dse-card', 'data-state': 'done' },
        h(Styles, null),
        head,
        h(
          'ul',
          { className: 'dse-list' },
          files.map(function (item) {
            return h(FileRow, {
              key: item.path,
              item: item,
              t: t,
              copied: copied === item.path,
              canPreview: canPreview,
              onCopy: onCopy,
              onPreview: onPreview,
            });
          }),
        ),
      );
    }

    /* ------------------------------------------------------------------ plugin */

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      var t = makeT(ctx.locale);

      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register(NS, 'en', EN);
          ctx.locale.register(NS, 'zh', ZH);
        }
      } catch (error) {
        /* a repeated registration must not take the plugin down */
      }

      var slot = ctx.slots;
      if (!slot || typeof slot.inject !== 'function') return;

      slot.inject(SLOT, function () {
        return slot.register(
          { name: SLOT, key: COMMAND_NAME },
          function CommandView(props) {
            return h(ExportCommandCard, { node: props.node, sessionId: props.sessionId, t: t, ctx: ctx });
          },
        );
      });
    }

    return {
      name: 'dsh-session-export',
      inject: inject,
      apply: apply,
      // Pure helpers, exposed for the node test runner; the browser never reads them.
      _internals: {
        parseExports: parseExports,
        fileAddress: fileAddress,
        splitPath: splitPath,
        bytesText: bytesText,
        makeT: makeT,
      },
    };
  },
});
