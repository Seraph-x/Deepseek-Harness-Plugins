/**
 * dsh-session-manager — browser half.
 *
 * Three surfaces, all plain React inside shipped slots:
 *   - `sidebar.workspaces.session.menu.item` → the "Delete session" row action
 *   - `settings.section`                     → the "Session manager" settings page
 *                                              (batch archive/delete, trash, config)
 *   - `shell.overlay`                        → confirm dialog and notices
 *
 * Everything that touches disk lives in the host half; this file only calls its
 * same-origin routes with `fetch` and then asks the client session store to
 * re-pull its baseline so a restored row appears without a page reload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var NS = 'dsh-session-manager';
    var DELETE_ENDPOINT = '/dsh-session-manager/delete';
    var TRASH_ENDPOINT = '/dsh-session-manager/trash';
    var RESTORE_ENDPOINT = '/dsh-session-manager/restore';
    var PURGE_ENDPOINT = '/dsh-session-manager/trash/purge';
    var SESSIONS_ENDPOINT = '/dsh-session-manager/sessions';
    var BATCH_DELETE_ENDPOINT = '/dsh-session-manager/batch/delete';
    var BATCH_ARCHIVE_ENDPOINT = '/dsh-session-manager/batch/archive';
    var CONFIG_ENDPOINT = '/dsh-session-manager/config';
    var INTENT_HEADER = 'x-dsh-session-manager';

    var MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    var OVERLAY_SLOT = 'shell.overlay';
    var SETTINGS_SLOT = 'settings.section';

    var EN = {
      'menu.delete': 'Delete session',
      'menu.deleteTitle': 'Delete “{title}”',
      'footer.trash': 'Trash',
      'footer.trashTitle': 'Sessions you deleted to the trash',
      'dialog.title': 'Delete this session?',
      'dialog.body': '“{title}” and its stored history will be deleted, not just hidden from the sidebar.',
      'dialog.hintTrash': 'Trash keeps the files on disk so you can restore them later.',
      'dialog.hintPurge': 'Purge deletes the session files immediately and cannot be undone.',
      'dialog.cancel': 'Cancel',
      'dialog.trash': 'Move to trash',
      'dialog.purge': 'Delete permanently',
      'dialog.busy': 'Deleting…',
      'notice.trashed': 'Session moved to the trash.',
      'notice.purged': 'Session deleted permanently.',
      'notice.partial': 'Session removed, but some files stayed on disk.',
      'notice.notFound': 'No session data found on disk.',
      'notice.failed': 'Delete failed.',
      'notice.busy': 'That session is still running.',
      'notice.undo': 'Undo',
      'notice.restored': 'Session restored.',
      'notice.restoredUnattached': 'Session restored, but it is not in this workspace yet.',
      'notice.restoreFailed': 'Restore failed.',
      'trash.title': 'Trash',
      'trash.subtitle': 'Deleted sessions are kept on disk until you purge them.',
      'trash.empty': 'The trash is empty.',
      'trash.loading': 'Loading…',
      'trash.close': 'Close',
      'trash.restore': 'Restore',
      'trash.purge': 'Purge',
      'trash.purgeArmed': 'Purge for good?',
      'trash.purgeAll': 'Empty trash',
      'trash.purgeAllArmed': 'Empty the trash for good?',
      'trash.untitled': 'Untitled session',
      'trash.unknownDate': 'unknown date',
      'trash.restored': 'Restored.',
      'trash.purged': 'Purged.',
      'trash.purgeAllDone': 'Trash emptied.',
      'trash.failed': 'Action failed.',
      'section.title': 'Session manager',
      'tab.sessions': 'Sessions',
      'tab.trash': 'Trash',
      'tab.config': 'Settings',
      'sessions.subtitle': 'Every session the Host knows about. Batch actions apply to the rows you tick.',
      'sessions.search': 'Filter by title, workspace or id',
      'sessions.refresh': 'Refresh',
      'sessions.selectAll': 'Select all',
      'sessions.clear': 'Clear selection',
      'sessions.selected': '{count} selected',
      'sessions.empty': 'No session matches this filter.',
      'sessions.loading': 'Loading sessions…',
      'sessions.failed': 'Could not load the session list.',
      'sessions.archived': 'Archived',
      'sessions.running': 'Running',
      'sessions.ungrouped': 'Ungrouped',
      'sessions.archive': 'Archive',
      'sessions.unarchive': 'Unarchive',
      'sessions.trash': 'Move to trash',
      'sessions.purge': 'Delete permanently',
      'sessions.purgeArmed': 'Delete permanently?',
      'filter.all': 'All',
      'filter.active': 'Active',
      'filter.archived': 'Archived',
      'filter.ungrouped': 'Ungrouped',
      'batch.archived': '{count} session(s) archived.',
      'batch.unarchived': '{count} session(s) unarchived.',
      'batch.trashed': '{count} session(s) moved to the trash.',
      'batch.purged': '{count} session(s) deleted permanently.',
      'batch.partial': 'Some sessions failed — see the list below.',
      'batch.none': 'Tick at least one session first.',
      'config.subtitle': 'What happens to a workspace\'s sessions when you delete that workspace.',
      'config.workspaceMode': 'When a workspace is deleted',
      'config.system': 'Leave them to the system (they fall into Ungrouped)',
      'config.archive': 'Archive them',
      'config.delete': 'Delete them',
      'config.deleteMode': 'When sessions are deleted by this plugin',
      'config.trashMode': 'Move to the trash (restorable)',
      'config.purgeMode': 'Delete permanently',
      'config.save': 'Save',
      'config.saved': 'Settings saved.',
      'config.failed': 'Could not save the settings.',
      'config.file': 'Stored in {file}',
      'config.lastPolicy': 'Last workspace delete',
    };

    var ZH = {
      'menu.delete': '删除会话',
      'menu.deleteTitle': '删除「{title}」',
      'footer.trash': '回收站',
      'footer.trashTitle': '删除到回收站的会话',
      'dialog.title': '删除这个会话？',
      'dialog.body': '「{title}」的会话记录与磁盘文件都会被删除，不是从侧栏隐藏。',
      'dialog.hintTrash': '「移到回收站」会把文件留在磁盘上，之后可以恢复。',
      'dialog.hintPurge': '「彻底删除」立即删除会话文件，无法撤销。',
      'dialog.cancel': '取消',
      'dialog.trash': '移到回收站',
      'dialog.purge': '彻底删除',
      'dialog.busy': '删除中…',
      'notice.trashed': '会话已移到回收站。',
      'notice.purged': '会话已彻底删除。',
      'notice.partial': '会话已移除，但部分文件仍在磁盘上。',
      'notice.notFound': '磁盘上找不到该会话的数据。',
      'notice.failed': '删除失败。',
      'notice.busy': '该会话仍在运行。',
      'notice.undo': '撤销',
      'notice.restored': '会话已恢复。',
      'notice.restoredUnattached': '会话已恢复，但还没挂回当前工作区。',
      'notice.restoreFailed': '恢复失败。',
      'trash.title': '回收站',
      'trash.subtitle': '被删除的会话会保留在磁盘上，直到你彻底清除。',
      'trash.empty': '回收站是空的。',
      'trash.loading': '加载中…',
      'trash.close': '关闭',
      'trash.restore': '恢复',
      'trash.purge': '彻底删除',
      'trash.purgeArmed': '再点一次确认彻底删除',
      'trash.purgeAll': '清空回收站',
      'trash.purgeAllArmed': '再点一次确认清空',
      'trash.untitled': '未命名会话',
      'trash.unknownDate': '时间未知',
      'trash.restored': '已恢复。',
      'trash.purged': '已彻底删除。',
      'trash.purgeAllDone': '回收站已清空。',
      'trash.failed': '操作失败。',
      'section.title': '会话管理',
      'tab.sessions': '会话',
      'tab.trash': '回收站',
      'tab.config': '设置',
      'sessions.subtitle': '这里列出 Host 已知的全部会话，批量操作只作用于你勾选的行。',
      'sessions.search': '按标题、工作区或 id 过滤',
      'sessions.refresh': '刷新',
      'sessions.selectAll': '全选',
      'sessions.clear': '取消选择',
      'sessions.selected': '已选 {count} 个',
      'sessions.empty': '没有符合当前过滤条件的会话。',
      'sessions.loading': '正在加载会话…',
      'sessions.failed': '加载会话列表失败。',
      'sessions.archived': '已归档',
      'sessions.running': '运行中',
      'sessions.ungrouped': '未分组',
      'sessions.archive': '归档',
      'sessions.unarchive': '解除归档',
      'sessions.trash': '移到回收站',
      'sessions.purge': '彻底删除',
      'sessions.purgeArmed': '再点一次确认彻底删除',
      'filter.all': '全部',
      'filter.active': '未归档',
      'filter.archived': '已归档',
      'filter.ungrouped': '未分组',
      'batch.archived': '已归档 {count} 个会话。',
      'batch.unarchived': '已解除归档 {count} 个会话。',
      'batch.trashed': '已把 {count} 个会话移到回收站。',
      'batch.purged': '已彻底删除 {count} 个会话。',
      'batch.partial': '部分会话处理失败，见下方列表。',
      'batch.none': '请先勾选至少一个会话。',
      'config.subtitle': '删除工作区时，其中的会话怎么处理。',
      'config.workspaceMode': '删除工作区时',
      'config.system': '交给系统处理（会话落到「未分组」）',
      'config.archive': '归档它们',
      'config.delete': '删除它们',
      'config.deleteMode': '本插件删除会话时',
      'config.trashMode': '移到回收站（可恢复）',
      'config.purgeMode': '彻底删除',
      'config.save': '保存',
      'config.saved': '设置已保存。',
      'config.failed': '保存设置失败。',
      'config.file': '保存在 {file}',
      'config.lastPolicy': '最近一次删除工作区',
    };

    /* ---------------------------------------------------------------- i18n */

    function detectLang() {
      try {
        var tag = document.documentElement.getAttribute('lang');
        if (tag) return String(tag).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (error) {
        /* fall through */
      }
      try {
        var nav = navigator.language || 'en';
        return String(nav).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    function dictFor(lang) {
      return lang === 'zh' ? ZH : EN;
    }

    function format(template, params) {
      if (typeof template !== 'string') return '';
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, function (match, key) {
        var value = params[key];
        return value === undefined || value === null ? match : String(value);
      });
    }

    function makeT(locale) {
      var bound = null;
      try {
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS);
      } catch (error) {
        bound = null;
      }
      var fallback = dictFor(detectLang());
      return function translate(key, params) {
        var text;
        if (bound) {
          try {
            text = bound(key, params);
          } catch (error) {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text.length === 0 || text === key) {
          text = fallback[key];
        }
        if (typeof text !== 'string') text = key;
        return format(text, params);
      };
    }

    var moduleT = makeT(null);

    /* --------------------------------------------------------------- store */

    var state = {
      request: null,
      busy: false,
      notice: null,
      trash: { open: false, loading: false, entries: [], error: null, busyId: null, armed: null },
      tab: 'sessions',
      sessions: {
        loading: false,
        rows: null,
        error: null,
        selection: [],
        filter: 'all',
        query: '',
        busy: false,
        armed: null,
        lastPolicy: null,
      },
      config: { loading: false, values: null, file: null, saving: false },
    };
    var listeners = new Set();

    function emit() {
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          /* a broken subscriber must not break the store */
        }
      });
    }

    function patch(next) {
      state = Object.assign({}, state, next);
      emit();
    }

    function patchTrash(next) {
      patch({ trash: Object.assign({}, state.trash, next) });
    }

    function patchSessions(next) {
      patch({ sessions: Object.assign({}, state.sessions, next) });
    }

    function patchConfig(next) {
      patch({ config: Object.assign({}, state.config, next) });
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function getState() {
      return state;
    }

    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, getState, getState);
      }
      var pair = React.useState(0);
      var bump = pair[1];
      React.useEffect(function () {
        return subscribe(function () {
          bump(function (value) {
            return value + 1;
          });
        });
      }, []);
      return state;
    }

    var noticeTimer = null;

    function showNotice(kind, text, action) {
      if (noticeTimer) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      patch({ notice: { kind: kind, text: text, action: action || null } });
      noticeTimer = setTimeout(function () {
        noticeTimer = null;
        patch({ notice: null });
      }, action ? 9000 : 5000);
    }

    function dismissNotice() {
      if (noticeTimer) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      patch({ notice: null });
    }

    /* -------------------------------------------------------------- bridge */

    var hostCtx = null;
    var fallbackRefresh = function () {};

    /** Re-pull the client Session baseline so restored rows materialize. */
    function refreshSessions() {
      try {
        var sessions = hostCtx && hostCtx.sessions;
        if (sessions && typeof sessions.refresh === 'function') {
          var result = sessions.refresh();
          if (result && typeof result.catch === 'function') result.catch(function () {});
          return;
        }
      } catch (error) {
        /* fall through */
      }
      fallbackRefresh();
    }

    function call(endpoint, options) {
      var init = { method: 'GET', headers: {} };
      init.headers[INTENT_HEADER] = '1';
      if (options && options.body !== undefined) {
        init.method = 'POST';
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      return fetch(endpoint, init).then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (payload) {
            return { status: response.status, payload: payload || {} };
          });
      });
    }

    /* ------------------------------------------------------------- actions */

    function requestDelete(sessionId, displayTitle, workspaceId) {
      if (!sessionId) return;
      patch({ request: { sessionId: sessionId, title: displayTitle || '', workspaceId: workspaceId || null } });
    }

    /** The workspace currently listing this Session, read from the row's snapshot hook. */
    function workspaceOf(props, sessionId) {
      try {
        var hook = props && props.useWorkspaces;
        if (typeof hook !== 'function') return null;
        var snapshot = hook();
        var items = (snapshot && (snapshot.items || snapshot.workspaces)) || [];
        for (var index = 0; index < items.length; index += 1) {
          var workspace = items[index];
          var ids = workspace && workspace.sessionIds;
          if (Array.isArray(ids) && ids.indexOf(sessionId) !== -1) return workspace.id || null;
        }
      } catch (error) {
        /* the row may not expose the hook */
      }
      return null;
    }

    /** Is a UI surface still holding this Session open? */
    function sessionIsOpen(sessionId) {
      try {
        var sessions = hostCtx && hostCtx.sessions;
        if (!sessions || typeof sessions.retainInfo !== 'function') return false;
        var info = sessions.retainInfo(sessionId);
        var snapshot = info && typeof info.getSnapshot === 'function' ? info.getSnapshot() : null;
        return !!(snapshot && snapshot.referenceCount > 0);
      } catch (error) {
        return false;
      }
    }

    /** Navigate off a Session that no longer exists so the pane is not stranded. */
    function leaveDeletedSession(workspaceId) {
      try {
        var ui = hostCtx && hostCtx.uiWorkspace;
        if (!ui) return;
        if (workspaceId && typeof ui.openWorkspace === 'function') {
          var opened = ui.openWorkspace(workspaceId);
          if (opened && typeof opened.catch === 'function') opened.catch(function () {});
          return;
        }
        if (typeof ui.startSession === 'function') {
          var started = ui.startSession();
          if (started && typeof started.catch === 'function') started.catch(function () {});
        }
      } catch (error) {
        /* navigation is a nicety, never a failure path */
      }
    }

    function cancelDelete() {
      patch({ request: null });
    }

    function runDelete(mode) {
      var request = state.request;
      if (!request || state.busy) return;
      var wasOpen = sessionIsOpen(request.sessionId);
      patch({ busy: true });
      call(DELETE_ENDPOINT, { body: { sessionId: request.sessionId, mode: mode, displayTitle: request.title } })
        .then(function (outcome) {
          var payload = outcome.payload;
          patch({ busy: false, request: null });
          if (payload && payload.ok) {
            /* The Host already pushed `api-session/removed`; step off the pane if
               this Session was the one on screen, then re-pull the baseline. */
            if (wasOpen) leaveDeletedSession(request.workspaceId);
            refreshSessions();
            var undo =
              mode === 'trash' && payload.trashId
                ? {
                    label: moduleT('notice.undo'),
                    run: function () {
                      restoreEntry(payload.trashId);
                    },
                  }
                : null;
            showNotice('success', moduleT(mode === 'trash' ? 'notice.trashed' : 'notice.purged'), undo);
            if (state.trash.open) reloadTrash();
            return;
          }
          var code = payload && payload.code;
          if (code === 'partial') {
            showNotice('warn', moduleT('notice.partial'));
          } else if (code === 'not-found') {
            showNotice('warn', moduleT('notice.notFound'));
          } else if (code === 'session-busy') {
            showNotice('warn', moduleT('notice.busy'));
          } else {
            showNotice('error', moduleT('notice.failed'));
          }
        })
        .catch(function () {
          patch({ busy: false });
          showNotice('error', moduleT('notice.failed'));
        });
    }

    function openTrash() {
      patchTrash({ open: true, loading: true, error: null, armed: null });
      reloadTrash();
    }

    function closeTrash() {
      patchTrash({ open: false, armed: null, busyId: null });
    }

    function reloadTrash() {
      patchTrash({ loading: true });
      call(TRASH_ENDPOINT)
        .then(function (outcome) {
          var payload = outcome.payload || {};
          var entries = Array.isArray(payload.entries) ? payload.entries : [];
          patchTrash({ loading: false, entries: entries, error: payload.ok ? null : moduleT('trash.failed') });
        })
        .catch(function () {
          patchTrash({ loading: false, error: moduleT('trash.failed') });
        });
    }

    function restoreEntry(trashId) {
      if (!trashId) return;
      patchTrash({ busyId: trashId });
      call(RESTORE_ENDPOINT, { body: { trashId: trashId } })
        .then(function (outcome) {
          var payload = outcome.payload || {};
          patchTrash({ busyId: null, armed: null });
          if (payload.ok) {
            refreshSessions();
            showNotice(
              payload.attachedTo ? 'success' : 'warn',
              moduleT(payload.attachedTo ? 'notice.restored' : 'notice.restoredUnattached'),
            );
            if (state.trash.open) reloadTrash();
            return;
          }
          showNotice('error', moduleT('notice.restoreFailed'));
        })
        .catch(function () {
          patchTrash({ busyId: null });
          showNotice('error', moduleT('notice.restoreFailed'));
        });
    }

    function purgeEntry(trashId) {
      if (!trashId) return;
      if (state.trash.armed !== trashId) {
        patchTrash({ armed: trashId });
        return;
      }
      patchTrash({ busyId: trashId, armed: null });
      call(PURGE_ENDPOINT, { body: { trashId: trashId } })
        .then(function (outcome) {
          patchTrash({ busyId: null });
          if (outcome.payload && outcome.payload.ok) {
            showNotice('success', moduleT('trash.purged'));
            reloadTrash();
          } else {
            showNotice('error', moduleT('trash.failed'));
          }
        })
        .catch(function () {
          patchTrash({ busyId: null });
          showNotice('error', moduleT('trash.failed'));
        });
    }

    function purgeAll() {
      if (state.trash.armed !== '*') {
        patchTrash({ armed: '*' });
        return;
      }
      patchTrash({ armed: null, busyId: '*' });
      call(PURGE_ENDPOINT, { body: { all: true } })
        .then(function (outcome) {
          patchTrash({ busyId: null });
          if (outcome.payload && outcome.payload.ok) {
            showNotice('success', moduleT('trash.purgeAllDone'));
            reloadTrash();
          } else {
            showNotice('error', moduleT('trash.failed'));
          }
        })
        .catch(function () {
          patchTrash({ busyId: null });
          showNotice('error', moduleT('trash.failed'));
        });
    }

    /* ------------------------------------------------- settings-page actions */

    function setTab(tab) {
      patch({ tab: tab });
      if (tab === 'sessions') loadSessions();
      else if (tab === 'trash') reloadTrash();
      else if (tab === 'config') loadConfig();
    }

    function loadSessions() {
      if (state.sessions.loading) return;
      patchSessions({ loading: true, error: null });
      call(SESSIONS_ENDPOINT)
        .then(function (result) {
          var payload = result.payload || {};
          if (!payload.ok) {
            patchSessions({ loading: false, error: payload.code || 'failed' });
            return;
          }
          var rows = Array.isArray(payload.sessions) ? payload.sessions : [];
          var known = {};
          rows.forEach(function (row) {
            known[row.sessionId] = true;
          });
          patchSessions({
            loading: false,
            error: null,
            rows: rows,
            lastPolicy: payload.lastPolicy || null,
            selection: state.sessions.selection.filter(function (id) {
              return known[id];
            }),
          });
        })
        .catch(function () {
          patchSessions({ loading: false, error: 'network' });
        });
    }

    function loadConfig() {
      if (state.config.loading) return;
      patchConfig({ loading: true });
      call(CONFIG_ENDPOINT)
        .then(function (result) {
          var payload = result.payload || {};
          if (!payload.ok) {
            patchConfig({ loading: false });
            return;
          }
          patchConfig({ loading: false, values: payload.config || {}, file: payload.file || null });
        })
        .catch(function () {
          patchConfig({ loading: false });
        });
    }

    function saveConfig(next) {
      if (state.config.saving) return;
      var values = Object.assign({}, state.config.values || {}, next);
      patchConfig({ saving: true, values: values });
      call(CONFIG_ENDPOINT, { body: next })
        .then(function (result) {
          var payload = result.payload || {};
          if (payload.ok) {
            patchConfig({ saving: false, values: payload.config || values });
            showNotice('success', moduleT('config.saved'));
          } else {
            patchConfig({ saving: false });
            showNotice('error', moduleT('config.failed'));
          }
        })
        .catch(function () {
          patchConfig({ saving: false });
          showNotice('error', moduleT('config.failed'));
        });
    }

    function setFilter(filter) {
      patchSessions({ filter: filter });
    }

    function setQuery(query) {
      patchSessions({ query: query });
    }

    function toggleSelection(sessionId) {
      var current = state.sessions.selection || [];
      var next = current.indexOf(sessionId) === -1
        ? current.concat([sessionId])
        : current.filter(function (id) {
            return id !== sessionId;
          });
      patchSessions({ selection: next, armed: null });
    }

    function selectMany(sessionIds) {
      patchSessions({ selection: sessionIds.slice(), armed: null });
    }

    function clearSelection() {
      patchSessions({ selection: [], armed: null });
    }

    /** Batch archive/unarchive: both directions are safe and immediate. */
    function batchArchive(archived) {
      var selection = state.sessions.selection || [];
      var t = moduleT;
      if (selection.length === 0) {
        showNotice('warn', t('batch.none'));
        return;
      }
      patchSessions({ busy: true, armed: null });
      call(BATCH_ARCHIVE_ENDPOINT, { body: { sessionIds: selection, archived: archived } })
        .then(function (result) {
          var payload = result.payload || {};
          patchSessions({ busy: false });
          if (payload.ok) {
            showNotice('success', format(t(archived ? 'batch.archived' : 'batch.unarchived'), { count: selection.length }));
          } else {
            showNotice('warn', t('batch.partial'));
          }
          loadSessions();
        })
        .catch(function () {
          patchSessions({ busy: false });
          showNotice('error', t('batch.partial'));
        });
    }

    /** Batch delete: the first click arms, the second one runs. */
    function batchDelete(mode) {
      var selection = state.sessions.selection || [];
      var t = moduleT;
      if (selection.length === 0) {
        showNotice('warn', t('batch.none'));
        return;
      }
      if (state.sessions.armed !== mode) {
        patchSessions({ armed: mode });
        return;
      }
      var anyOpen = selection.some(sessionIsOpen);
      patchSessions({ busy: true, armed: null });
      call(BATCH_DELETE_ENDPOINT, { body: { sessionIds: selection, mode: mode } })
        .then(function (result) {
          var payload = result.payload || {};
          patchSessions({ busy: false, selection: [] });
          if (payload.ok) {
            showNotice('success', format(t(mode === 'purge' ? 'batch.purged' : 'batch.trashed'), { count: selection.length }));
          } else {
            showNotice('warn', t('batch.partial'));
          }
          if (anyOpen) leaveDeletedSession(null);
          refreshSessions();
          loadSessions();
        })
        .catch(function () {
          patchSessions({ busy: false });
          showNotice('error', t('batch.partial'));
        });
    }

    /* ---------------------------------------------------------------- styles */

    var token = function (name, fallback) {
      return 'var(--dsw-alias-' + name + ', ' + fallback + ')';
    };

    var styles = {
      /* Mirrors the shipped row exactly: min-height 34, padding 6px 8px, gap 6,
         13px/20px label, 14px icon slot, hover from the danger hover token. */
      menuItem: function (hovered) {
        return {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          minHeight: 34,
          padding: '6px 8px',
          border: 'none',
          borderRadius: 'var(--dsw-radius-md, 8px)',
          background: hovered ? token('interactive-bg-hover-danger', 'rgba(229,72,77,0.14)') : 'transparent',
          color: token('state-error-primary', '#e5484d'),
          fontSize: 13,
          lineHeight: '20px',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'inherit',
        };
      },
      menuIcon: {
        display: 'inline-flex',
        flex: 'none',
        width: 14,
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
        color: token('state-error-primary', '#e5484d'),
      },
      menuLabel: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      separator: {
        height: '0.5px',
        margin: '3px 2px',
        background: token('border-l2', 'rgba(127,127,127,0.25)'),
      },
      footerButton: function (hovered, wide) {
        var collapsed = wide === false;
        return {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: collapsed ? 0 : 6,
          height: 28,
          width: collapsed ? 28 : undefined,
          padding: collapsed ? 0 : '0 8px',
          border: 'none',
          borderRadius: 6,
          background: hovered ? token('interactive-bg-hover', 'rgba(127,127,127,0.14)') : 'transparent',
          color: token('label-secondary', '#8b8b8b'),
          fontSize: 12,
          cursor: 'pointer',
          fontFamily: 'inherit',
        };
      },
      backdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: token('bg-mask-1', 'rgba(0,0,0,0.42)'),
        pointerEvents: 'auto',
      },
      card: {
        width: 420,
        maxWidth: 'calc(100vw - 32px)',
        padding: 18,
        borderRadius: 12,
        background: token('bg-layer-1', '#1c1c1e'),
        color: token('label-primary', '#e8e8e8'),
        border: '1px solid ' + token('border-l1', 'rgba(127,127,127,0.25)'),
        boxShadow: '0 18px 48px rgba(0,0,0,0.36)',
        fontSize: 13,
        lineHeight: '20px',
      },
      trashCard: {
        width: 560,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'min(70vh, 640px)',
        display: 'flex',
        flexDirection: 'column',
        padding: 18,
        borderRadius: 12,
        background: token('bg-layer-1', '#1c1c1e'),
        color: token('label-primary', '#e8e8e8'),
        border: '1px solid ' + token('border-l1', 'rgba(127,127,127,0.25)'),
        boxShadow: '0 18px 48px rgba(0,0,0,0.36)',
        fontSize: 13,
        lineHeight: '20px',
      },
      title: { fontSize: 15, fontWeight: 600, marginBottom: 8 },
      body: { color: token('label-secondary', '#a8a8a8'), marginBottom: 6 },
      hint: { color: token('label-tertiary', '#8b8b8b'), fontSize: 12, marginBottom: 4 },
      actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
      /* Every action button is transparent — no filled red anywhere. Hierarchy
         comes from the label colour plus a hairline border. */
      button: function (variant, disabled, hovered) {
        var base = {
          height: 30,
          padding: '0 12px',
          borderRadius: 7,
          fontSize: 13,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          fontFamily: 'inherit',
          background: 'transparent',
          transition: 'background-color 120ms ease, border-color 120ms ease',
        };
        if (variant === 'danger') {
          base.color = token('state-error-primary', '#e5484d');
          base.border = '1px solid ' + token('state-error-primary', '#e5484d');
          if (hovered && !disabled) {
            base.background = token('interactive-bg-hover-danger', 'rgba(229,72,77,0.14)');
          }
        } else if (variant === 'ghost') {
          base.color = token('label-secondary', '#a8a8a8');
          base.border = '1px solid ' + token('border-l2', 'rgba(127,127,127,0.3)');
          if (hovered && !disabled) {
            base.background = token('interactive-bg-hover', 'rgba(127,127,127,0.14)');
          }
        } else {
          base.color = token('label-primary', '#e8e8e8');
          base.border = '1px solid ' + token('border-l2', 'rgba(127,127,127,0.3)');
          if (hovered && !disabled) {
            base.background = token('interactive-bg-hover', 'rgba(127,127,127,0.14)');
          }
        }
        return base;
      },
      list: { marginTop: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 9,
        background: token('bg-layer-2', 'rgba(127,127,127,0.1)'),
      },
      rowText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      rowTitle: {
        fontSize: 13,
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      rowMeta: { fontSize: 11, color: token('label-tertiary', '#8b8b8b') },
      rowActions: { display: 'flex', gap: 6, flexShrink: 0 },
      notice: function (kind) {
        var color =
          kind === 'error'
            ? token('state-error-primary', '#e5484d')
            : kind === 'warn'
              ? token('state-warn-primary', '#d97706')
              : token('state-success-primary', '#2f9e44');
        return {
          position: 'fixed',
          left: '50%',
          bottom: 24,
          transform: 'translateX(-50%)',
          zIndex: 70,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          maxWidth: 'calc(100vw - 48px)',
          padding: '9px 14px',
          borderRadius: 999,
          background: token('toast-bg', '#1c1c1e'),
          color: token('toast-label', '#e8e8e8'),
          border: '1px solid ' + color,
          boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
          fontSize: 12,
          pointerEvents: 'auto',
        };
      },
      noticeAction: {
        border: 'none',
        background: 'transparent',
        color: token('link', '#3b82f6'),
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: 0,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 },
      sectionHeader: { display: 'flex', flexDirection: 'column', gap: 4 },
      sectionTitle: {
        fontSize: 15,
        lineHeight: '22px',
        fontWeight: 600,
        color: token('label-primary', 'inherit'),
      },
      sectionSubtitle: { fontSize: 12, lineHeight: '18px', color: token('label-tertiary', 'inherit') },
      tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid ' + token('border-l1', 'rgba(127,127,127,0.2)') },
      tab: function (active) {
        return {
          appearance: 'none',
          border: 'none',
          borderBottom: '2px solid ' + (active ? token('brand-primary', '#4a65e8') : 'transparent'),
          background: 'transparent',
          color: active ? token('label-primary', 'inherit') : token('label-secondary', 'inherit'),
          fontSize: 13,
          lineHeight: '20px',
          padding: '6px 10px',
          cursor: 'pointer',
          fontFamily: 'inherit',
        };
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      search: {
        flex: '1 1 200px',
        minWidth: 160,
        border: '1px solid ' + token('border-l2', 'rgba(127,127,127,0.3)'),
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: token('label-primary', 'inherit'),
        fontSize: 13,
        lineHeight: '20px',
        padding: '5px 8px',
        fontFamily: 'inherit',
        outline: 'none',
      },
      chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      chip: function (active) {
        return {
          border: '1px solid ' + (active ? token('brand-primary', '#4a65e8') : token('border-l2', 'rgba(127,127,127,0.3)')),
          borderRadius: 999,
          background: 'transparent',
          color: active ? token('brand-primary', '#4a65e8') : token('label-secondary', 'inherit'),
          fontSize: 12,
          lineHeight: '18px',
          padding: '3px 10px',
          cursor: 'pointer',
          fontFamily: 'inherit',
        };
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 380,
        overflowY: 'auto',
        border: '1px solid ' + token('border-l1', 'rgba(127,127,127,0.2)'),
        borderRadius: 'var(--dsw-radius-md, 8px)',
      },
      sessionRow: function (selected) {
        return {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          borderBottom: '1px solid ' + token('border-l1', 'rgba(127,127,127,0.12)'),
          background: selected ? token('interactive-bg-hover', 'rgba(127,127,127,0.12)') : 'transparent',
        };
      },
      checkbox: { flex: 'none', width: 14, height: 14, accentColor: token('brand-primary', '#4a65e8'), cursor: 'pointer' },
      badges: { display: 'flex', gap: 4, flex: 'none' },
      badge: function (kind) {
        var color =
          kind === 'running'
            ? token('state-success-primary', '#3fb950')
            : kind === 'archived'
              ? token('label-caption', 'rgba(127,127,127,0.8)')
              : token('label-tertiary', 'inherit');
        return {
          border: '1px solid ' + color,
          borderRadius: 999,
          color: color,
          fontSize: 11,
          lineHeight: '16px',
          padding: '0 6px',
          flex: 'none',
        };
      },
      empty: { padding: '18px 10px', textAlign: 'center', fontSize: 13, color: token('label-tertiary', 'inherit') },
      error: { fontSize: 12, lineHeight: '18px', color: token('state-error-primary', '#e5484d') },
      fieldset: { display: 'flex', flexDirection: 'column', gap: 8 },
      fieldsetTitle: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: token('label-primary', 'inherit') },
      radioRow: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, lineHeight: '20px', cursor: 'pointer' },
      radio: { flex: 'none', marginTop: 3, accentColor: token('brand-primary', '#4a65e8'), cursor: 'pointer' },
      filePath: { fontSize: 11, lineHeight: '16px', color: token('label-caption', 'inherit'), wordBreak: 'break-all' },
    };

    /* ------------------------------------------------------------ components */

    function useHover() {
      var pair = React.useState(false);
      var hovered = pair[0];
      var setHovered = pair[1];
      return [
        hovered,
        {
          onMouseEnter: function () {
            setHovered(true);
          },
          onMouseLeave: function () {
            setHovered(false);
          },
        },
      ];
    }

    /** The slot hands the row menu's open state through a hook; call it in render. */
    function resolveMenuSetter(props) {
      var hook = props.useMenuOpenState || (props.hooks && props.hooks.menuOpenState);
      if (typeof hook === 'function') {
        try {
          var pair = hook();
          if (Array.isArray(pair) && typeof pair[1] === 'function') return pair[1];
        } catch (error) {
          /* fall through to the prop the slot may hand us directly */
        }
      }
      if (typeof props.setMenuOpen === 'function') return props.setMenuOpen;
      return null;
    }

    /** Transparent, hairline-bordered action button with a hover tint. */
    function ActionButton(props) {
      var hover = useHover();
      var disabled = Boolean(props.disabled);
      return h(
        'button',
        Object.assign(
          {
            type: 'button',
            disabled: disabled,
            onClick: props.onClick,
            style: styles.button(props.variant, disabled, !disabled && hover[0]),
          },
          disabled ? {} : hover[1],
        ),
        props.children,
      );
    }

    /** 14px trash outline, drawn to sit in the shipped icon slot. */
    function TrashIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M2.9 4.4h10.2M6.4 4.4V2.9h3.2v1.5M4.3 4.4l.55 8.05a1.05 1.05 0 0 0 1.05.95h4.2a1.05 1.05 0 0 0 1.05-.95l.55-8.05',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M6.6 7.1v4.1M9.4 7.1v4.1',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
        }),
      );
    }

    function DeleteMenuItem(props) {
      var t = props.t || moduleT;
      var hover = useHover();
      var setMenuOpen = resolveMenuSetter(props);
      var title = props.displayTitle || '';
      var onSelect = function () {
        if (typeof setMenuOpen === 'function') setMenuOpen(false);
        (props.requestDelete || requestDelete)(props.sessionId, title, workspaceOf(props, props.sessionId));
      };
      return h(
        React.Fragment,
        null,
        h('div', { role: 'separator', style: styles.separator }),
        h(
          'button',
          Object.assign(
            {
              type: 'button',
              role: 'menuitem',
              title: title ? format(t('menu.deleteTitle'), { title: title }) : t('menu.delete'),
              onClick: onSelect,
              style: styles.menuItem(hover[0]),
            },
            hover[1],
          ),
          h('span', { style: styles.menuIcon }, h(TrashIcon, null)),
          h('span', { style: styles.menuLabel }, t('menu.delete')),
        ),
      );
    }

    function formatSize(bytes) {
      var value = Number(bytes) || 0;
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function formatDate(value) {
      if (!value) return moduleT('trash.unknownDate');
      try {
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return moduleT('trash.unknownDate');
        return date.toLocaleString();
      } catch (error) {
        return moduleT('trash.unknownDate');
      }
    }

    function TrashRow(props) {
      var t = props.t || moduleT;
      var entry = props.entry;
      var armed = props.armed;
      var busy = props.busy;
      var label = entry.displayTitle || entry.sessionId || t('trash.untitled');
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowText },
          h('div', { style: styles.rowTitle, title: entry.originalPath || entry.sessionId }, label),
          h(
            'div',
            { style: styles.rowMeta },
            formatDate(entry.deletedAt) + ' · ' + formatSize(entry.sizeBytes) + ' · ' + entry.sessionId,
          ),
        ),
        h(
          'div',
          { style: styles.rowActions },
          h(
            ActionButton,
            {
              variant: 'primary',
              disabled: busy,
              onClick: function () {
                props.onRestore(entry.trashId);
              },
            },
            t('trash.restore'),
          ),
          h(
            ActionButton,
            {
              variant: 'danger',
              disabled: busy,
              onClick: function () {
                props.onPurge(entry.trashId);
              },
            },
            armed ? t('trash.purgeArmed') : t('trash.purge'),
          ),
        ),
      );
    }

    function OverlayHost(props) {
      var t = props.t || moduleT;
      var snapshot = useStore();
      var request = snapshot.request;
      var trash = snapshot.trash;
      var notice = snapshot.notice;

      React.useEffect(
        function () {
          if (!request && !trash.open) return undefined;
          var onKey = function (event) {
            if (event.key !== 'Escape') return;
            if (request) (props.cancelDelete || cancelDelete)();
            else if (trash.open) (props.closeTrash || closeTrash)();
          };
          window.addEventListener('keydown', onKey);
          return function () {
            window.removeEventListener('keydown', onKey);
          };
        },
        [request, trash.open],
      );

      var parts = [];

      if (request) {
        parts.push(
          h(
            'div',
            {
              key: 'dialog-backdrop',
              style: styles.backdrop,
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) (props.cancelDelete || cancelDelete)();
              },
            },
            h(
              'div',
              { role: 'dialog', 'aria-modal': 'true', style: styles.card },
              h('div', { style: styles.title }, t('dialog.title')),
              h('div', { style: styles.body }, format(t('dialog.body'), { title: request.title || request.sessionId })),
              h('div', { style: styles.hint }, t('dialog.hintTrash')),
              h('div', { style: styles.hint }, t('dialog.hintPurge')),
              h(
                'div',
                { style: styles.actions },
                h(
                  ActionButton,
                  {
                    variant: 'ghost',
                    disabled: snapshot.busy,
                    onClick: function () {
                      (props.cancelDelete || cancelDelete)();
                    },
                  },
                  t('dialog.cancel'),
                ),
                h(
                  ActionButton,
                  {
                    variant: 'danger',
                    disabled: snapshot.busy,
                    onClick: function () {
                      (props.runDelete || runDelete)('purge');
                    },
                  },
                  snapshot.busy ? t('dialog.busy') : t('dialog.purge'),
                ),
                h(
                  ActionButton,
                  {
                    variant: 'primary',
                    disabled: snapshot.busy,
                    onClick: function () {
                      (props.runDelete || runDelete)('trash');
                    },
                  },
                  snapshot.busy ? t('dialog.busy') : t('dialog.trash'),
                ),
              ),
            ),
          ),
        );
      }

      if (trash.open) {
        var rows = [];
        if (trash.loading && trash.entries.length === 0) {
          rows.push(
            h('div', { key: 'loading', style: styles.body }, t('trash.loading')),
          );
        } else if (trash.entries.length === 0) {
          rows.push(h('div', { key: 'empty', style: styles.body }, t('trash.empty')));
        } else {
          trash.entries.forEach(function (entry) {
            rows.push(
              h(TrashRow, {
                key: entry.trashId,
                entry: entry,
                t: t,
                armed: trash.armed === entry.trashId,
                busy: trash.busyId === entry.trashId,
                onRestore: function (id) {
                  (props.restoreEntry || restoreEntry)(id);
                },
                onPurge: function (id) {
                  (props.purgeEntry || purgeEntry)(id);
                },
              }),
            );
          });
        }

        parts.push(
          h(
            'div',
            {
              key: 'trash-backdrop',
              style: styles.backdrop,
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) (props.closeTrash || closeTrash)();
              },
            },
            h(
              'div',
              { role: 'dialog', 'aria-modal': 'true', style: styles.trashCard },
              h('div', { style: styles.title }, t('trash.title')),
              h('div', { style: styles.body }, t('trash.subtitle')),
              trash.error ? h('div', { style: styles.hint }, trash.error) : null,
              h('div', { style: styles.list }, rows),
              h(
                'div',
                { style: styles.actions },
                h(
                  ActionButton,
                  {
                    variant: 'danger',
                    disabled: trash.entries.length === 0 || trash.busyId === '*',
                    onClick: function () {
                      (props.purgeAll || purgeAll)();
                    },
                  },
                  trash.armed === '*' ? t('trash.purgeAllArmed') : t('trash.purgeAll'),
                ),
                h(
                  ActionButton,
                  {
                    variant: 'ghost',
                    onClick: function () {
                      (props.closeTrash || closeTrash)();
                    },
                  },
                  t('trash.close'),
                ),
              ),
            ),
          ),
        );
      }

      if (notice) {
        parts.push(
          h(
            'div',
            { key: 'notice', role: 'status', style: styles.notice(notice.kind) },
            h('span', null, notice.text),
            notice.action
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: styles.noticeAction,
                    onClick: function () {
                      var action = notice.action;
                      dismissNotice();
                      if (action && typeof action.run === 'function') action.run();
                    },
                  },
                  notice.action.label,
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                style: styles.noticeAction,
                'aria-label': 'dismiss',
                onClick: function () {
                  dismissNotice();
                },
              },
              '×',
            ),
          ),
        );
      }

      if (parts.length === 0) return null;
      return h(React.Fragment, null, parts);
    }

    /* ---------------------------------------------------- settings surface */

    var FILTERS = ['all', 'active', 'archived', 'ungrouped'];

    function visibleRows(sessions) {
      var rows = sessions.rows || [];
      var filter = sessions.filter || 'all';
      var query = (sessions.query || '').trim().toLowerCase();
      return rows.filter(function (row) {
        if (filter === 'archived' && !row.archived) return false;
        if (filter === 'active' && row.archived) return false;
        if (filter === 'ungrouped' && row.workspaceId) return false;
        if (query === '') return true;
        var haystack = [row.title, row.workspaceTitle, row.sessionId, row.cwd]
          .filter(function (value) {
            return typeof value === 'string' && value !== '';
          })
          .join(' ')
          .toLowerCase();
        return haystack.indexOf(query) !== -1;
      });
    }

    function SessionRow(props) {
      var t = props.t || moduleT;
      var row = props.row;
      var badges = [];
      if (row.running) badges.push(h('span', { key: 'run', style: styles.badge('running') }, t('sessions.running')));
      if (row.archived) badges.push(h('span', { key: 'arch', style: styles.badge('archived') }, t('sessions.archived')));
      var where = row.workspaceTitle || t('sessions.ungrouped');
      var when = row.updatedAt ? formatDate(row.updatedAt) : t('trash.unknownDate');
      return h(
        'div',
        { style: styles.sessionRow(props.selected) },
        h('input', {
          type: 'checkbox',
          style: styles.checkbox,
          checked: props.selected === true,
          onChange: function () {
            props.onToggle(row.sessionId);
          },
        }),
        h(
          'div',
          { style: styles.rowText },
          h('div', { style: styles.rowTitle, title: row.sessionId }, row.title || row.sessionId),
          h('div', { style: styles.rowMeta }, where + ' · ' + when),
        ),
        h('div', { style: styles.badges }, badges),
      );
    }

    function SessionsTab(props) {
      var t = props.t || moduleT;
      var sessions = props.sessions;
      var rows = visibleRows(sessions);
      var selection = sessions.selection || [];
      var busy = sessions.busy === true;
      var allSelected =
        rows.length > 0 &&
        rows.every(function (row) {
          return selection.indexOf(row.sessionId) !== -1;
        });

      var body;
      if (sessions.rows === null && sessions.loading) {
        body = h('div', { style: styles.empty }, t('sessions.loading'));
      } else if (sessions.error) {
        body = h('div', { style: styles.empty }, t('sessions.failed'));
      } else if (rows.length === 0) {
        body = h('div', { style: styles.empty }, t('sessions.empty'));
      } else {
        body = h(
          'div',
          { style: styles.list },
          rows.map(function (row) {
            return h(SessionRow, {
              key: row.sessionId,
              row: row,
              t: t,
              selected: selection.indexOf(row.sessionId) !== -1,
              onToggle: toggleSelection,
            });
          }),
        );
      }

      var noSelection = selection.length === 0;

      return h(
        'div',
        { style: styles.section },
        h(
          'div',
          { style: styles.toolbar },
          h('input', {
            style: styles.search,
            placeholder: t('sessions.search'),
            value: sessions.query || '',
            onChange: function (event) {
              setQuery(event.target.value);
            },
          }),
          h(
            ActionButton,
            {
              variant: 'ghost',
              disabled: sessions.loading,
              onClick: function () {
                loadSessions();
              },
            },
            t('sessions.refresh'),
          ),
        ),
        h(
          'div',
          { style: styles.chips },
          FILTERS.map(function (filter) {
            return h(
              'button',
              {
                key: filter,
                type: 'button',
                style: styles.chip((sessions.filter || 'all') === filter),
                onClick: function () {
                  setFilter(filter);
                },
              },
              t('filter.' + filter),
            );
          }),
        ),
        h(
          'div',
          { style: styles.toolbar },
          h(
            ActionButton,
            {
              variant: 'ghost',
              disabled: rows.length === 0,
              onClick: function () {
                if (allSelected) clearSelection();
                else
                  selectMany(
                    rows.map(function (row) {
                      return row.sessionId;
                    }),
                  );
              },
            },
            allSelected ? t('sessions.clear') : t('sessions.selectAll'),
          ),
          noSelection
            ? null
            : h('span', { style: styles.rowMeta }, format(t('sessions.selected'), { count: selection.length })),
          h(
            ActionButton,
            {
              variant: 'primary',
              disabled: busy || noSelection,
              onClick: function () {
                batchArchive(true);
              },
            },
            t('sessions.archive'),
          ),
          h(
            ActionButton,
            {
              variant: 'primary',
              disabled: busy || noSelection,
              onClick: function () {
                batchArchive(false);
              },
            },
            t('sessions.unarchive'),
          ),
          h(
            ActionButton,
            {
              variant: 'danger',
              disabled: busy || noSelection,
              onClick: function () {
                batchDelete('trash');
              },
            },
            t('sessions.trash'),
          ),
          h(
            ActionButton,
            {
              variant: 'danger',
              disabled: busy || noSelection,
              onClick: function () {
                batchDelete('purge');
              },
            },
            sessions.armed === 'purge' ? t('sessions.purgeArmed') : t('sessions.purge'),
          ),
        ),
        body,
      );
    }

    function TrashTab(props) {
      var t = props.t || moduleT;
      var trash = props.trash;
      var entries = trash.entries || [];
      var body;
      if (trash.loading && entries.length === 0) body = h('div', { style: styles.empty }, t('trash.loading'));
      else if (entries.length === 0) body = h('div', { style: styles.empty }, t('trash.empty'));
      else {
        body = h(
          'div',
          { style: styles.list },
          entries.map(function (entry) {
            return h(TrashRow, {
              key: entry.trashId,
              entry: entry,
              t: t,
              busy: trash.busyId === entry.trashId,
              armed: trash.armed === entry.trashId,
              onRestore: restoreEntry,
              onPurge: purgeEntry,
            });
          }),
        );
      }
      return h(
        'div',
        { style: styles.section },
        h('div', { style: styles.sectionSubtitle }, t('trash.subtitle')),
        h(
          'div',
          { style: styles.toolbar },
          h(
            ActionButton,
            {
              variant: 'ghost',
              disabled: trash.loading,
              onClick: function () {
                reloadTrash();
              },
            },
            t('sessions.refresh'),
          ),
          h(
            ActionButton,
            {
              variant: 'danger',
              disabled: entries.length === 0,
              onClick: function () {
                purgeAll();
              },
            },
            trash.armed === '*' ? t('trash.purgeAllArmed') : t('trash.purgeAll'),
          ),
        ),
        body,
      );
    }

    function RadioGroup(props) {
      var t = props.t || moduleT;
      return h(
        'div',
        { style: styles.fieldset },
        h('div', { style: styles.fieldsetTitle }, props.title),
        props.options.map(function (option) {
          return h(
            'label',
            { key: option.value, style: styles.radioRow },
            h('input', {
              type: 'radio',
              style: styles.radio,
              name: props.name,
              checked: props.value === option.value,
              onChange: function () {
                props.onChange(option.value);
              },
            }),
            h('span', null, t(option.label)),
          );
        }),
      );
    }

    function ConfigTab(props) {
      var t = props.t || moduleT;
      var config = props.config;
      var values = config.values || {};
      var workspaceMode = values.workspaceDeleteMode || 'system';
      var deleteMode = values.deleteMode || 'trash';
      return h(
        'div',
        { style: styles.section },
        h('div', { style: styles.sectionSubtitle }, t('config.subtitle')),
        h(RadioGroup, {
          t: t,
          name: 'workspace-delete-mode',
          title: t('config.workspaceMode'),
          value: workspaceMode,
          options: [
            { value: 'system', label: 'config.system' },
            { value: 'archive', label: 'config.archive' },
            { value: 'delete', label: 'config.delete' },
          ],
          onChange: function (value) {
            saveConfig({ workspaceDeleteMode: value });
          },
        }),
        h(RadioGroup, {
          t: t,
          name: 'delete-mode',
          title: t('config.deleteMode'),
          value: deleteMode,
          options: [
            { value: 'trash', label: 'config.trashMode' },
            { value: 'purge', label: 'config.purgeMode' },
          ],
          onChange: function (value) {
            saveConfig({ deleteMode: value });
          },
        }),
        config.file ? h('div', { style: styles.filePath }, format(t('config.file'), { file: config.file })) : null,
        config.saving ? h('div', { style: styles.sectionSubtitle }, t('trash.loading')) : null,
      );
    }

    function SettingsSection(props) {
      var t = props.t || moduleT;
      var snapshot = useStore();
      var tab = snapshot.tab || 'sessions';

      React.useEffect(
        function () {
          if (tab === 'sessions' && snapshot.sessions.rows === null && !snapshot.sessions.loading) loadSessions();
          if (tab === 'trash' && !snapshot.trash.loading && (snapshot.trash.entries || []).length === 0) reloadTrash();
          if (tab === 'config' && snapshot.config.values === null && !snapshot.config.loading) loadConfig();
        },
        [tab],
      );

      var body;
      if (tab === 'trash') body = h(TrashTab, { t: t, trash: snapshot.trash });
      else if (tab === 'config') body = h(ConfigTab, { t: t, config: snapshot.config });
      else body = h(SessionsTab, { t: t, sessions: snapshot.sessions });

      return h(
        'div',
        { style: styles.section },
        h(
          'div',
          { style: styles.sectionHeader },
          h('div', { style: styles.sectionTitle }, t('section.title')),
          h('div', { style: styles.sectionSubtitle }, t('sessions.subtitle')),
        ),
        h(
          'div',
          { style: styles.tabBar },
          ['sessions', 'trash', 'config'].map(function (key) {
            return h(
              'button',
              {
                key: key,
                type: 'button',
                style: styles.tab(tab === key),
                onClick: function () {
                  setTab(key);
                },
              },
              t('tab.' + key),
            );
          }),
        ),
        body,
      );
    }

    /* -------------------------------------------------------------- plugin */

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      hostCtx = ctx;

      ctx.effect(
        function () {
          var dispose = [];
          try {
            if (ctx.locale && typeof ctx.locale.register === 'function') {
              ctx.locale.register(NS, 'en', EN);
              ctx.locale.register(NS, 'zh', ZH);
            }
          } catch (error) {
            /* a repeated registration must not take the plugin down */
          }
          return function () {
            dispose.forEach(function (fn) {
              try {
                fn();
              } catch (error) {
                /* already gone */
              }
            });
          };
        },
        'session-manager: dictionaries',
      );

      fallbackRefresh = function () {
        try {
          if (ctx.sessions && typeof ctx.sessions.refresh === 'function') {
            var result = ctx.sessions.refresh();
            if (result && typeof result.catch === 'function') result.catch(function () {});
          }
        } catch (error) {
          /* nothing else to try */
        }
      };

      var t = makeT(ctx.locale);

      var slot = ctx.slots;
      if (!slot || typeof slot.inject !== 'function') return;

      slot.inject(MENU_SLOT, function () {
        return slot.register(
          {
            name: MENU_SLOT,
            id: 'session-manager.menu',
            order: 500,
            label: function () {
              return t('menu.delete');
            },
            inject: function () {
              return { t: t, requestDelete: requestDelete };
            },
          },
          DeleteMenuItem,
        );
      });

      slot.inject(SETTINGS_SLOT, function () {
        return slot.register(
          {
            name: SETTINGS_SLOT,
            id: 'session-manager',
            order: 600,
            label: function () {
              return t('section.title');
            },
            inject: function () {
              return { t: t };
            },
          },
          SettingsSection,
        );
      });

      slot.inject(OVERLAY_SLOT, function () {
        return slot.register(
          {
            name: OVERLAY_SLOT,
            id: 'session-manager.dialog',
            order: 500,
            inject: function () {
              return { t: t };
            },
          },
          OverlayHost,
        );
      });
    }

    var exports = {
      name: 'session-manager',
      inject: inject,
      apply: apply,
    };
    return exports;
  },
});
