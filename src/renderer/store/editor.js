import { clipboard, ipcRenderer, shell, webFrame } from 'electron';
import path from 'path';
import equal from 'deep-equal';
import { isSamePathSync } from 'common/filesystem/paths';
import bus from '../bus';
import { hasKeys, getUniqueId } from '../util';
import listToTree from '../util/listToTree';
import { createDocumentState, getOptionsFromState, getSingleFileState, getBlankFileState } from './help';
import notice from '../services/notification';
import {
  FileEncodingCommand,
  LineEndingCommand,
  QuickOpenCommand,
  TrailingNewlineCommand
} from '../commands';

const autoSaveTimers = new Map();

const state = {
  currentFile: {},
  tabs: [],
  listToc: [], // Just use for deep equal check. and replace with new toc if needed.仅用于深度相等检查。并根据需要更换新的目录。
  toc: []
};

const mutations = {
  // set search key and matches also index 设置搜索键和匹配也索引
  SET_SEARCH (state, value) {
    state.currentFile.searchMatches = value;
  },
  SET_TOC (state, toc) {
    state.listToc = toc;
    state.toc = listToTree(toc);
  },
  SET_CURRENT_FILE (state, currentFile) {
    const oldCurrentFile = state.currentFile;
    if (!oldCurrentFile.id || oldCurrentFile.id !== currentFile.id) {
      const { id, markdown, cursor, history, pathname } = currentFile;
      window.DIRNAME = pathname ? path.dirname(pathname) : '';
      // set state first, then emit file changed event 首先设置状态，然后发出文件更改事件
      state.currentFile = currentFile;
      bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history });
    }
  },
  ADD_FILE_TO_TABS (state, currentFile) {
    state.tabs.push(currentFile);
  },
  REMOVE_FILE_WITHIN_TABS (state, file) {
    const { tabs, currentFile } = state;
    const index = tabs.indexOf(file);
    tabs.splice(index, 1);

    if (file.id && autoSaveTimers.has(file.id)) {
      const timer = autoSaveTimers.get(file.id);
      clearTimeout(timer);
      autoSaveTimers.delete(file.id);
    }

    if (file.id === currentFile.id) {
      const fileState = state.tabs[index] || state.tabs[index - 1] || state.tabs[0] || {};
      state.currentFile = fileState;
      if (typeof fileState.markdown === 'string') {
        const { id, markdown, cursor, history, pathname } = fileState;
        window.DIRNAME = pathname ? path.dirname(pathname) : '';
        bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history });
      }
    }

    if (state.tabs.length === 0) {
      // Handle close the last tab, need to reset the TOC state 句柄关闭最后一个tab，需要重置TOC状态
      state.listToc = [];
      state.toc = [];
    }
  },
  // Exchange from with to and move from to the end if to is null or empty.
  // 如果 to 为 null 或为空，则从 to 交换并从 to 移动到结尾。
  EXCHANGE_TABS_BY_ID (state, tabIDs) {
    const { fromId } = tabIDs;
    const toId = tabIDs.toId; // may be null 可能为空

    const { tabs } = state;
    const moveItem = (arr, from, to) => {
      if (from === to) return true;
      const len = arr.length;
      const item = arr.splice(from, 1);
      if (item.length === 0) return false;

      arr.splice(to, 0, item[0]);
      return arr.length === len;
    };

    const fromIndex = tabs.findIndex(t => t.id === fromId);
    if (!toId) {
      moveItem(tabs, fromIndex, tabs.length - 1);
    } else {
      const toIndex = tabs.findIndex(t => t.id === toId);
      const realToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
      moveItem(tabs, fromIndex, realToIndex);
    }
  },
  LOAD_CHANGE (state, change) {
    const { tabs, currentFile } = state;
    const { data, pathname } = change;
    const {
      isMixedLineEndings,
      lineEnding,
      adjustLineEndingOnSave,
      trimTrailingNewline,
      encoding,
      markdown,
      filename
    } = data;
    const options = { encoding, lineEnding, adjustLineEndingOnSave, trimTrailingNewline };

    // Create a new document and update few entires later.创建一个新文档并稍后更新几个整体。
    const newFileState = getSingleFileState({ markdown, filename, pathname, options });

    const tab = tabs.find(t => isSamePathSync(t.pathname, pathname));
    if (!tab) {
      // The tab may be closed in the meanwhile.选项卡可能会同时关闭。
      console.error('LOAD_CHANGE: Cannot find tab in tab list.');
      notice.notify({
        title: 'Error loading tab',
        message: 'There was an error while loading the file change because the tab cannot be found.',
        type: 'error',
        time: 20000,
        showConfirm: false
      });
      return;
    }

    // Backup few entries that we need to restore later.备份一些我们需要稍后恢复的条目。
    const oldId = tab.id;
    const oldNotifications = tab.notifications;
    let oldHistory = null;
    if (tab.history.index >= 0 && tab.history.stack.length >= 1) {
      // Allow to restore the old document.允许恢复旧文档。
      oldHistory = {
        stack: [tab.history.stack[tab.history.index]],
        index: 0
      };

      // Free reference from array 从数组中免费引用
      tab.history.index--;
      tab.history.stack.pop();
    }

    // Update file content and restore some entries.更新文件内容并恢复一些条目。
    Object.assign(tab, newFileState);
    tab.id = oldId;
    tab.notifications = oldNotifications;
    if (oldHistory) {
      tab.history = oldHistory;
    }

    if (isMixedLineEndings) {
      tab.notifications.push({
        msg: `"${filename}" has mixed line endings which are automatically normalized to ${lineEnding.toUpperCase()}.`,
        showConfirm: false,
        style: 'info',
        exclusiveType: '',
        action: () => { }
      });
    }

    // Reload the editor if the tab is currently opened.如果选项卡当前打开，则重新加载编辑器。
    if (pathname === currentFile.pathname) {
      state.currentFile = tab;
      const { id, cursor, history } = tab;
      bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history });
    }
  },
  // NOTE: Please call this function only from main process via "mt::set-pathname" and free resources before!
  // 注意：请仅通过“mt::set-pathname”从主进程调用此函数并释放资源！
  SET_PATHNAME (state, { tab, fileInfo }) {
    const { currentFile } = state;
    const { filename, pathname, id } = fileInfo;

    // Change reference path for images.更改图像的参考路径。
    if (id === currentFile.id && pathname) {
      window.DIRNAME = path.dirname(pathname);
    }

    if (tab) {
      Object.assign(tab, { filename, pathname, isSaved: true });
    }
  },
  SET_SAVE_STATUS_BY_TAB (state, { tab, status }) {
    if (hasKeys(tab)) {
      tab.isSaved = status;
    }
  },
  SET_SAVE_STATUS (state, status) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.isSaved = status;
    }
  },
  SET_SAVE_STATUS_WHEN_REMOVE (state, { pathname }) {
    state.tabs.forEach(f => {
      if (f.pathname === pathname) {
        f.isSaved = false;
      }
    });
  },
  SET_MARKDOWN (state, markdown) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.markdown = markdown;
    }
  },
  SET_DOCUMENT_ENCODING (state, encoding) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.encoding = encoding;
    }
  },
  SET_LINE_ENDING (state, lineEnding) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.lineEnding = lineEnding;
    }
  },
  SET_FILE_ENCODING_BY_NAME (state, encodingName) {
    if (hasKeys(state.currentFile)) {
      const { encoding: encodingObj } = state.currentFile;
      encodingObj.encoding = encodingName;
      encodingObj.isBom = false;
    }
  },
  SET_FINAL_NEWLINE (state, value) {
    if (hasKeys(state.currentFile) && value >= 0 && value <= 3) {
      state.currentFile.trimTrailingNewline = value;
    }
  },
  SET_ADJUST_LINE_ENDING_ON_SAVE (state, adjustLineEndingOnSave) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.adjustLineEndingOnSave = adjustLineEndingOnSave;
    }
  },
  SET_WORD_COUNT (state, wordCount) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.wordCount = wordCount;
    }
  },
  SET_CURSOR (state, cursor) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.cursor = cursor;
    }
  },
  SET_HISTORY (state, history) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.history = history;
    }
  },
  CLOSE_TABS (state, tabIdList) {
    if (!tabIdList || tabIdList.length === 0) return;

    let tabIndex = 0;
    tabIdList.forEach(id => {
      const index = state.tabs.findIndex(f => f.id === id);
      const { pathname } = state.tabs[index];

      // Notify main process to remove the file from the window and free resources.
      // 通知主进程从窗口中删除文件并释放资源。
      if (pathname) {
        ipcRenderer.send('mt::window-tab-closed', pathname);
      }

      state.tabs.splice(index, 1);
      if (state.currentFile.id === id) {
        state.currentFile = {};
        window.DIRNAME = '';
        if (tabIdList.length === 1) {
          tabIndex = index;
        }
      }
    });

    if (!state.currentFile.id && state.tabs.length) {
      state.currentFile = state.tabs[tabIndex] || state.tabs[tabIndex - 1] || state.tabs[0] || {};
      if (typeof state.currentFile.markdown === 'string') {
        const { id, markdown, cursor, history, pathname } = state.currentFile;
        window.DIRNAME = pathname ? path.dirname(pathname) : '';
        bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history });
      }
    }

    if (state.tabs.length === 0) {
      // Handle close the last tab, need to reset the TOC state
      // 句柄关闭最后一个tab，需要重置TOC状态
      state.listToc = [];
      state.toc = [];
    }
  },
  RENAME_IF_NEEDED (state, { src, dest }) {
    const { tabs } = state;
    tabs.forEach(f => {
      if (f.pathname === src) {
        f.pathname = dest;
        f.filename = path.basename(dest);
      }
    });
  },

  // Push a tab specific notification on stack that never disappears.
  // 在堆栈上推送一个不会消失的选项卡特定通知。
  PUSH_TAB_NOTIFICATION (state, data) {
    const defaultAction = () => { };
    const { tabId, msg } = data;
    const action = data.action || defaultAction;
    const showConfirm = data.showConfirm || false;
    const style = data.style || 'info';
    // Whether only one notification should exist.
    // 是否应该只存在一个通知。
    const exclusiveType = data.exclusiveType || '';

    const { tabs } = state;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.error('PUSH_TAB_NOTIFICATION: Cannot find tab in tab list.');
      return;
    }

    const { notifications } = tab;

    // Remove the old notification if only one should exist.
    // 如果只存在一个通知，请删除旧通知。
    if (exclusiveType) {
      const index = notifications.findIndex(n => n.exclusiveType === exclusiveType);
      if (index >= 0) {
        // Reorder current notification 重新排序当前通知
        notifications.splice(index, 1);
      }
    }

    // Push new notification on stack.在堆栈上推送新通知。
    notifications.push({
      msg,
      showConfirm,
      style,
      exclusiveType,
      action: action
    });
  }
};

const actions = {
  FORMAT_LINK_CLICK ({ commit }, { data, dirname }) {
    ipcRenderer.send('mt::format-link-click', { data, dirname });
  },

  LISTEN_SCREEN_SHOT ({ commit }) {
    ipcRenderer.on('mt::screenshot-captured', e => {
      bus.$emit('screenshot-captured');
    });
  },

  // image path auto complement  图像路径自动补全
  ASK_FOR_IMAGE_AUTO_PATH ({ commit, state }, src) {
    const { pathname } = state.currentFile;
    if (pathname) {
      let rs;
      const promise = new Promise((resolve, reject) => {
        rs = resolve;
      });
      const id = getUniqueId();
      ipcRenderer.once(`mt::response-of-image-path-${id}`, (e, files) => {
        rs(files);
      });
      ipcRenderer.send('mt::ask-for-image-auto-path', { pathname, src, id });
      return promise;
    } else {
      return [];
    }
  },

  SEARCH ({ commit }, value) {
    commit('SET_SEARCH', value);
  },

  SHOW_IMAGE_DELETION_URL ({ commit }, deletionUrl) {
    notice.notify({
      title: 'Image deletion URL',
      message: `Click to copy the deletion URL of the uploaded image to the clipboard (${deletionUrl}).`,
      showConfirm: true,
      time: 20000
    })
      .then(() => {
        clipboard.writeText(deletionUrl);
      });
  },

  FORCE_CLOSE_TAB ({ commit, dispatch }, file) {
    commit('REMOVE_FILE_WITHIN_TABS', file);
    const { pathname } = file;

    // Notify main process to remove the file from the window and free resources.通知主进程从窗口中删除文件并释放资源。
    if (pathname) {
      ipcRenderer.send('mt::window-tab-closed', pathname);
    }
  },

  EXCHANGE_TABS_BY_ID ({ commit }, tabIDs) {
    commit('EXCHANGE_TABS_BY_ID', tabIDs);
  },

  // We need to update line endings menu when changing tabs.更改标签时，我们需要更新行尾菜单。
  UPDATE_LINE_ENDING_MENU ({ state }) {
    const { lineEnding } = state.currentFile;
    if (lineEnding) {
      const { windowId } = global.marktext.env;
      ipcRenderer.send('mt::update-line-ending-menu', windowId, lineEnding);
    }
  },

  CLOSE_UNSAVED_TAB ({ commit, state }, file) {
    const { id, pathname, filename, markdown } = file;
    const options = getOptionsFromState(file);

    // Save the file content via main process and send a close tab response.通过主进程保存文件内容并发送关闭选项卡响应。
    ipcRenderer.send('mt::save-and-close-tabs', [{ id, pathname, filename, markdown, options }]);
  },

  // need pass some data to main process when `save` menu item clicked.单击“保存”菜单项时需要将一些数据传递给主进程。
  LISTEN_FOR_SAVE ({ state, rootState }) {
    ipcRenderer.on('mt::editor-ask-file-save', () => {
      const { id, filename, pathname, markdown } = state.currentFile;
      const options = getOptionsFromState(state.currentFile);
      const defaultPath = getRootFolderFromState(rootState);
      if (id) {
        ipcRenderer.send('mt::response-file-save', {
          id,
          filename,
          pathname,
          markdown,
          options,
          defaultPath
        });
      }
    });
  },

  // need pass some data to main process when `save as` menu item clicked 单击“另存为”菜单项时需要将一些数据传递给主进程
  LISTEN_FOR_SAVE_AS ({ state, rootState }) {
    ipcRenderer.on('mt::editor-ask-file-save-as', () => {
      const { id, filename, pathname, markdown } = state.currentFile;
      const options = getOptionsFromState(state.currentFile);
      const defaultPath = getRootFolderFromState(rootState);
      if (id) {
        ipcRenderer.send('mt::response-file-save-as', {
          id,
          filename,
          pathname,
          markdown,
          options,
          defaultPath
        });
      }
    });
  },

  LISTEN_FOR_SET_PATHNAME ({ commit, dispatch, state }) {
    ipcRenderer.on('mt::set-pathname', (e, fileInfo) => {
      const { tabs } = state;
      const { pathname, id } = fileInfo;
      const tab = tabs.find(f => f.id === id);
      if (!tab) {
        console.err('[ERROR] Cannot change file path from unknown tab.');
        return;
      }

      // If a tab with the same file path already exists we need to close the tab.// 如果已经存在具有相同文件路径的选项卡，我们需要关闭该选项卡。
      // The existing tab is overwritten by this tab.// 现有选项卡被此选项卡覆盖。
      const existingTab = tabs.find(t => t.id !== id && isSamePathSync(t.pathname, pathname));
      if (existingTab) {
        dispatch('CLOSE_TAB', existingTab);
      }
      commit('SET_PATHNAME', { tab, fileInfo });
    });

    ipcRenderer.on('mt::tab-saved', (e, tabId) => {
      const { tabs } = state;
      const tab = tabs.find(f => f.id === tabId);
      if (tab) {
        Object.assign(tab, { isSaved: true });
      }
    });

    ipcRenderer.on('mt::tab-save-failure', (e, tabId, msg) => {
      const { tabs } = state;
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) {
        notice.notify({
          title: 'Save failure',
          message: msg,
          type: 'error',
          time: 20000,
          showConfirm: false
        });
        return;
      }

      commit('SET_SAVE_STATUS_BY_TAB', { tab, status: false });
      commit('PUSH_TAB_NOTIFICATION', {
        tabId,
        msg: `There was an error while saving: ${msg}`,
        style: 'crit'
      });
    });
  },

  LISTEN_FOR_CLOSE ({ state }) {
    ipcRenderer.on('mt::ask-for-close', e => {
      const unsavedFiles = state.tabs
        .filter(file => !file.isSaved)
        .map(file => {
          const { id, filename, pathname, markdown } = file;
          const options = getOptionsFromState(file);
          return { id, filename, pathname, markdown, options };
        });

      if (unsavedFiles.length) {
        ipcRenderer.send('mt::close-window-confirm', unsavedFiles);
      } else {
        ipcRenderer.send('mt::close-window');
      }
    });
  },

  LISTEN_FOR_SAVE_CLOSE ({ commit }) {
    ipcRenderer.on('mt::force-close-tabs-by-id', (e, tabIdList) => {
      if (Array.isArray(tabIdList) && tabIdList.length) {
        commit('CLOSE_TABS', tabIdList);
      }
    });
  },

  ASK_FOR_SAVE_ALL ({ commit, state }, closeTabs) {
    const { tabs } = state;
    const unsavedFiles = tabs
      .filter(file => !(file.isSaved && /[^\n]/.test(file.markdown)))
      .map(file => {
        const { id, filename, pathname, markdown } = file;
        const options = getOptionsFromState(file);
        return { id, filename, pathname, markdown, options };
      });

    if (closeTabs) {
      if (unsavedFiles.length) {
        commit('CLOSE_TABS', tabs.filter(f => f.isSaved).map(f => f.id));
        ipcRenderer.send('mt::save-and-close-tabs', unsavedFiles);
      } else {
        commit('CLOSE_TABS', tabs.map(f => f.id));
      }
    } else {
      ipcRenderer.send('mt::save-tabs', unsavedFiles);
    }
  },

  LISTEN_FOR_MOVE_TO ({ state, rootState }) {
    ipcRenderer.on('mt::editor-move-file', () => {
      const { id, filename, pathname, markdown } = state.currentFile;
      const options = getOptionsFromState(state.currentFile);
      const defaultPath = getRootFolderFromState(rootState);
      if (!id) return;
      if (!pathname) {
        // if current file is a newly created file, just save it! 如果当前文件是新创建的文件，只需保存即可！
        ipcRenderer.send('mt::response-file-save', {
          id,
          filename,
          pathname,
          markdown,
          options,
          defaultPath
        });
      } else {
        // if not, move to a new(maybe) folder 如果没有，请移至新的（可能）文件夹
        ipcRenderer.send('mt::response-file-move-to', { id, pathname });
      }
    });
  },

  LISTEN_FOR_RENAME ({ commit, state, dispatch }) {
    ipcRenderer.on('mt::editor-rename-file', () => {
      dispatch('RESPONSE_FOR_RENAME');
    });
  },

  RESPONSE_FOR_RENAME ({ state, rootState }) {
    const { id, filename, pathname, markdown } = state.currentFile;
    const options = getOptionsFromState(state.currentFile);
    const defaultPath = getRootFolderFromState(rootState);
    if (!id) return;
    if (!pathname) {
      // if current file is a newly created file, just save it! 如果当前文件是新创建的文件，只需保存即可！
      ipcRenderer.send('mt::response-file-save', {
        id,
        filename,
        pathname,
        markdown,
        options,
        defaultPath
      });
    } else {
      bus.$emit('rename');
    }
  },

  // ask for main process to rename this file to a new name `newFilename` 要求主进程将此文件重命名为新名称`newFilename`
  RENAME ({ commit, state }, newFilename) {
    const { id, pathname, filename } = state.currentFile;
    if (typeof filename === 'string' && filename !== newFilename) {
      const newPathname = path.join(path.dirname(pathname), newFilename);
      ipcRenderer.send('mt::rename', { id, pathname, newPathname });
    }
  },

  UPDATE_CURRENT_FILE ({ commit, state, dispatch }, currentFile) {
    commit('SET_CURRENT_FILE', currentFile);
    const { tabs } = state;
    if (!tabs.some(file => file.id === currentFile.id)) {
      commit('ADD_FILE_TO_TABS', currentFile);
    }
    dispatch('UPDATE_LINE_ENDING_MENU');
  },

  // This events are only used during window creation. 此事件仅在窗口创建期间使用。
  LISTEN_FOR_BOOTSTRAP_WINDOW ({ commit, state, dispatch, rootState }) {
    // Delay load runtime commands and initialize commands.延迟加载运行时命令和初始化命令。
    setTimeout(() => {
      bus.$emit('cmd::register-command', new FileEncodingCommand(rootState.editor));
      bus.$emit('cmd::register-command', new QuickOpenCommand(rootState));
      bus.$emit('cmd::register-command', new LineEndingCommand(rootState.editor));
      bus.$emit('cmd::register-command', new TrailingNewlineCommand(rootState.editor));

      setTimeout(() => {
        ipcRenderer.send('mt::request-keybindings');
        bus.$emit('cmd::sort-commands');
      }, 100);
    }, 400);

    ipcRenderer.on('mt::bootstrap-editor', (e, config) => {
      const {
        addBlankTab,
        markdownList,
        lineEnding,
        sideBarVisibility,
        tabBarVisibility,
        sourceCodeModeEnabled
      } = config;

      dispatch('SEND_INITIALIZED');
      commit('SET_USER_PREFERENCE', { endOfLine: lineEnding });
      commit('SET_LAYOUT', {
        rightColumn: 'files',
        showSideBar: !!sideBarVisibility,
        showTabBar: !!tabBarVisibility
      });
      dispatch('DISPATCH_LAYOUT_MENU_ITEMS');

      commit('SET_MODE', {
        type: 'sourceCode',
        checked: !!sourceCodeModeEnabled
      });

      if (addBlankTab) {
        dispatch('NEW_UNTITLED_TAB', {});
      } else if (markdownList.length) {
        let isFirst = true;
        for (const markdown of markdownList) {
          isFirst = false;
          dispatch('NEW_UNTITLED_TAB', { markdown, selected: isFirst });
        }
      }
    });
  },

  // Open a new tab, optionally with content.打开一个新选项卡，可选择包含内容。
  LISTEN_FOR_NEW_TAB ({ dispatch }) {
    ipcRenderer.on('mt::open-new-tab', (e, markdownDocument, options = {}, selected = true) => {
      if (markdownDocument) {
        // Create tab with content.创建包含内容的选项卡。
        dispatch('NEW_TAB_WITH_CONTENT', { markdownDocument, options, selected });
      } else {
        // Fallback: create a blank tab and always select it 后备：创建一个空白选项卡并始终选择它
        dispatch('NEW_UNTITLED_TAB', {});
      }
    });

    ipcRenderer.on('mt::new-untitled-tab', (e, selected = true, markdown = '') => {
      // Create a blank tab  创建一个空白选项卡
      dispatch('NEW_UNTITLED_TAB', { markdown, selected });
    });
  },

  LISTEN_FOR_CLOSE_TAB ({ commit, state, dispatch }) {
    ipcRenderer.on('mt::editor-close-tab', e => {
      const file = state.currentFile;
      if (!hasKeys(file)) return;
      dispatch('CLOSE_TAB', file);
    });
  },

  LISTEN_FOR_TAB_CYCLE ({ commit, state, dispatch }) {
    ipcRenderer.on('mt::tabs-cycle-left', e => {
      dispatch('CYCLE_TABS', false);
    });
    ipcRenderer.on('mt::tabs-cycle-right', e => {
      dispatch('CYCLE_TABS', true);
    });
  },

  LISTEN_FOR_SWITCH_TABS ({ commit, state, dispatch }) {
    ipcRenderer.on('mt::switch-tab-by-index', (event, index) => {
      dispatch('SWITCH_TAB_BY_INDEX', index);
    });
  },

  CLOSE_TAB ({ dispatch }, file) {
    const { isSaved } = file;
    if (isSaved) {
      dispatch('FORCE_CLOSE_TAB', file);
    } else {
      dispatch('CLOSE_UNSAVED_TAB', file);
    }
  },

  CLOSE_OTHER_TABS ({ state, dispatch }, file) {
    const { tabs } = state;
    tabs.filter(f => f.id !== file.id).forEach(tab => {
      dispatch('CLOSE_TAB', tab);
    });
  },

  CLOSE_SAVED_TABS ({ state, dispatch }) {
    const { tabs } = state;
    tabs.filter(f => f.isSaved).forEach(tab => {
      dispatch('CLOSE_TAB', tab);
    });
  },

  CLOSE_ALL_TABS ({ state, dispatch }) {
    const { tabs } = state;
    tabs.slice().forEach(tab => {
      dispatch('CLOSE_TAB', tab);
    });
  },

  RENAME_FILE ({ commit, dispatch }, file) {
    commit('SET_CURRENT_FILE', file);
    dispatch('UPDATE_LINE_ENDING_MENU');
    bus.$emit('rename');
  },

  // Direction is a boolean where false is left and true right.Direction 是一个布尔值，其中 false 为左，true 为右。
  CYCLE_TABS ({ commit, dispatch, state }, direction) {
    const { tabs, currentFile } = state;
    if (tabs.length <= 1) {
      return;
    }

    const currentIndex = tabs.findIndex(t => t.id === currentFile.id);
    if (currentIndex === -1) {
      console.error('CYCLE_TABS: Cannot find current tab index.');
      return;
    }

    let nextTabIndex = 0;
    if (!direction) {
      // Switch tab to the left.将选项卡切换到左侧。
      nextTabIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
    } else {
      // Switch tab to the right.将选项卡切换到右侧。
      nextTabIndex = (currentIndex + 1) % tabs.length;
    }

    const nextTab = tabs[nextTabIndex];
    if (!nextTab || !nextTab.id) {
      console.error(`CYCLE_TABS: Cannot find next tab (index="${nextTabIndex}").`);
      return;
    }

    commit('SET_CURRENT_FILE', nextTab);
    dispatch('UPDATE_LINE_ENDING_MENU');
  },

  SWITCH_TAB_BY_INDEX ({ commit, dispatch, state }, nextTabIndex) {
    const { tabs, currentFile } = state;
    if (nextTabIndex < 0 || nextTabIndex >= tabs.length) {
      console.warn('Invalid tab index:', nextTabIndex);
      return;
    }

    const currentIndex = tabs.findIndex(t => t.id === currentFile.id);
    if (currentIndex === -1) {
      console.error('Cannot find current tab index.');
      return;
    }

    const nextTab = tabs[nextTabIndex];
    if (!nextTab || !nextTab.id) {
      console.error(`Cannot find tab by index="${nextTabIndex}".`);
      return;
    }

    commit('SET_CURRENT_FILE', nextTab);
    dispatch('UPDATE_LINE_ENDING_MENU');
  },

  /**
   * Create a new untitled tab optional from a markdown string.从 markdown 字符串创建一个新的无标题选项卡可选。
   *
   * @param {*} context The store context.商店上下文。
   * @param {{markdown?: string, selected?: boolean}} obj Optional markdown string obj 可选的降价字符串
   * and whether the tab should become the selected tab (true if not set).以及选项卡是否应成为选定选项卡（如果未设置，则为 true）。
   */
  NEW_UNTITLED_TAB ({ commit, state, dispatch, rootState }, { markdown: markdownString, selected }) {
    // If not set select the tab. 如果未设置，请选择选项卡。
    if (selected == null) {
      selected = true;
    }

    dispatch('SHOW_TAB_VIEW', false);

    const { defaultEncoding, endOfLine } = rootState.preferences;
    const { tabs } = state;
    const fileState = getBlankFileState(tabs, defaultEncoding, endOfLine, markdownString);

    if (selected) {
      const { id, markdown } = fileState;
      dispatch('UPDATE_CURRENT_FILE', fileState);
      bus.$emit('file-loaded', { id, markdown });
    } else {
      commit('ADD_FILE_TO_TABS', fileState);
    }
  },

  /**
   * Create a new tab from the given markdown document. 从给定的降价文档创建一个新选项卡。
   *
   * @param {*} context The store context.
   * @param {{markdownDocument: IMarkdownDocumentRaw, selected?: boolean}} obj The markdown document // obj markdown 文档
   * and optional whether the tab should become the selected tab (true if not set). // 和可选的选项卡是否应该成为选定的选项卡（如果未设置，则为 true）。
   */
  NEW_TAB_WITH_CONTENT ({ commit, state, dispatch }, { markdownDocument, options = {}, selected }) {
    if (!markdownDocument) {
      console.warn('Cannot create a file tab without a markdown document!');
      dispatch('NEW_UNTITLED_TAB', {});
      return;
    }

    // Select the tab if not value is specified.如果未指定值，请选择选项卡。
    if (typeof selected === 'undefined') {
      selected = true;
    }
    // Check if tab already exist and always select existing tab if so.检查选项卡是否已存在，如果存在，请始终选择现有选项卡。
    const { currentFile, tabs } = state;
    const { pathname } = markdownDocument;
    const existingTab = tabs.find(t => isSamePathSync(t.pathname, pathname));
    if (existingTab) {
      dispatch('UPDATE_CURRENT_FILE', existingTab);
      return;
    }

    // Replace/close selected untitled empty tab  替换/关闭选定的无标题空选项卡
    let keepTabBarState = false;
    if (currentFile) {
      const { isSaved, pathname } = currentFile;
      if (isSaved && !pathname) {
        keepTabBarState = true;
        dispatch('FORCE_CLOSE_TAB', currentFile);
      }
    }

    if (!keepTabBarState) {
      dispatch('SHOW_TAB_VIEW', false);
    }

    const { markdown, isMixedLineEndings } = markdownDocument;
    const docState = createDocumentState(Object.assign(markdownDocument, options));
    const { id, cursor } = docState;

    if (selected) {
      dispatch('UPDATE_CURRENT_FILE', docState);
      bus.$emit('file-loaded', { id, markdown, cursor });
    } else {
      commit('ADD_FILE_TO_TABS', docState);
    }

    if (isMixedLineEndings) {
      const { filename, lineEnding } = markdownDocument;
      commit('PUSH_TAB_NOTIFICATION', {
        tabId: id,
        msg: `${filename}" has mixed line endings which are automatically normalized to ${lineEnding.toUpperCase()}.`
      });
    }
  },

  SHOW_TAB_VIEW ({ commit, state, dispatch }, always) {
    const { tabs } = state;
    if (always || tabs.length === 1) {
      commit('SET_LAYOUT', { showTabBar: true });
      dispatch('DISPATCH_LAYOUT_MENU_ITEMS');
    }
  },

  // Content change from realtime preview editor and source code editor
  // WORKAROUND: id is "muya" if changes come from muya and not source code editor! So we don't have to apply the workaround.
  // 实时预览编辑器和源代码编辑器的内容更改
  // 解决方法：如果更改来自 muya 而不是源代码编辑器，则 id 为“muya”！ 所以我们不必应用解决方法。
  LISTEN_FOR_CONTENT_CHANGE ({ commit, dispatch, state, rootState }, { id, markdown, wordCount, cursor, history, toc }) {
    const { autoSave } = rootState.preferences;
    const {
      id: currentId,
      filename,
      pathname,
      markdown: oldMarkdown,
      trimTrailingNewline
    } = state.currentFile;
    const { listToc } = state;

    if (!id) {
      throw new Error('Listen for document change but id was not set!');
    } else if (!currentId || state.tabs.length === 0) {
      // Discard changes - this case should normally not occur.
      // 放弃更改 - 这种情况通常不会发生。
      return;
    } else if (id !== 'muya' && currentId !== id) {
      // WORKAROUND: We commit changes after switching the tab in source code mode.
      // Update old tab or discard changes
      // 解决方法：我们在源代码模式下切换选项卡后提交更改。
      // 更新旧选项卡或放弃更改
      for (const tab of state.tabs) {
        if (tab.id && tab.id === id) {
          tab.markdown = adjustTrailingNewlines(markdown, tab.trimTrailingNewline);
          // Set cursor
          // 设置光标
          if (cursor) {
            tab.cursor = cursor;
          }
          // Set history
          // 设置历史
          if (history) {
            tab.history = history;
          }
          break;
        }
      }
      return;
    }

    markdown = adjustTrailingNewlines(markdown, trimTrailingNewline);
    commit('SET_MARKDOWN', markdown);

    // Ignore new line which is added if the editor text is empty (#422)
    // 如果编辑器文本为空，则忽略添加的新行 (#422)
    if (oldMarkdown.length === 0 && markdown.length === 1 && markdown[0] === '\n') {
      return;
    }

    // Word count
    // 字数
    if (wordCount) {
      commit('SET_WORD_COUNT', wordCount);
    }
    // Set cursor
    // 设置光标
    if (cursor) {
      commit('SET_CURSOR', cursor);
    }
    // Set history
    if (history) {
      commit('SET_HISTORY', history);
    }
    // Set toc
    // 设置目录
    if (toc && !equal(toc, listToc)) {
      commit('SET_TOC', toc);
    }

    // Change save status/save to file only when the markdown changed!
    // 仅当 markdown 更改时更改保存状态/保存到文件！
    if (markdown !== oldMarkdown) {
      commit('SET_SAVE_STATUS', false);

      // Save file is auto save is enable and file exist on disk.
      // 保存文件是自动保存启用并且文件存在于磁盘上。
      if (pathname && autoSave) {
        const options = getOptionsFromState(state.currentFile);
        dispatch('HANDLE_AUTO_SAVE', {
          id: currentId,
          filename,
          pathname,
          markdown,
          options
        });
      }
    }
  },

  HANDLE_AUTO_SAVE ({ commit, state, rootState }, { id, filename, pathname, markdown, options }) {
    if (!id || !pathname) {
      throw new Error('HANDLE_AUTO_SAVE: Invalid tab.');
    }

    const { tabs } = state;
    const { autoSaveDelay } = rootState.preferences;

    if (autoSaveTimers.has(id)) {
      const timer = autoSaveTimers.get(id);
      clearTimeout(timer);
      autoSaveTimers.delete(id);
    }

    const timer = setTimeout(() => {
      autoSaveTimers.delete(id);

      // Validate that the tab still exists. A tab is unchanged until successfully saved
      // or force closed. The user decides whether to discard or save the tab when
      // gracefully closed. The automatically save event may fire meanwhile.
      // 验证选项卡是否仍然存在。 在成功保存之前，选项卡保持不变
      // 或强制关闭。 用户决定是否丢弃或保存选项卡时
      // 优雅地关闭。 自动保存事件可能同时触发。
      const tab = tabs.find(t => t.id === id);
      if (tab && !tab.isSaved) {
        const defaultPath = getRootFolderFromState(rootState);

        // Tab changed status is set after the file is saved.
        ipcRenderer.send('mt::response-file-save', {
          id,
          filename,
          pathname,
          markdown,
          options,
          defaultPath
        });
      }
    }, autoSaveDelay);
    autoSaveTimers.set(id, timer);
  },

  SELECTION_CHANGE ({ commit }, changes) {
    const { start, end } = changes;
    // Set search keyword to store.
    // 设置要存储的搜索关键字。
    if (start.key === end.key && start.block.text) {
      const value = start.block.text.substring(start.offset, end.offset);
      commit('SET_SEARCH', {
        matches: [],
        index: -1,
        value
      });
    }

    const { windowId } = global.marktext.env;
    ipcRenderer.send('mt::editor-selection-changed', windowId, createApplicationMenuState(changes));
  },

  SELECTION_FORMATS (_, formats) {
    const { windowId } = global.marktext.env;
    ipcRenderer.send('mt::update-format-menu', windowId, createSelectionFormatState(formats));
  },

  EXPORT ({ state }, { type, content, pageOptions }) {
    if (!hasKeys(state.currentFile)) return;

    // Extract title from TOC buffer.
    // 从 TOC 缓冲区中提取标题。
    let title = '';
    const { listToc } = state;
    if (listToc && listToc.length > 0) {
      let headerRef = listToc[0];

      // The main title should be at the beginning of the document.
      // 主标题应该在文档的开头。
      const len = Math.min(listToc.length, 6);
      for (let i = 1; i < len; ++i) {
        if (headerRef.lvl === 1) {
          break;
        }

        const header = listToc[i];
        if (headerRef.lvl > header.lvl) {
          headerRef = header;
        }
      }
      title = headerRef.content;
    }

    const { filename, pathname } = state.currentFile;
    ipcRenderer.send('mt::response-export', {
      type,
      title,
      content,
      filename,
      pathname,
      pageOptions
    });
  },

  LINTEN_FOR_EXPORT_SUCCESS ({ commit }) {
    ipcRenderer.on('mt::export-success', (e, { type, filePath }) => {
      notice.notify({
        title: 'Exported successfully',
        message: `Exported "${path.basename(filePath)}" successfully!`,
        showConfirm: true
      })
        .then(() => {
          shell.showItemInFolder(filePath);
        });
    });
  },

  PRINT_RESPONSE ({ commit }) {
    ipcRenderer.send('mt::response-print');
  },

  LINTEN_FOR_PRINT_SERVICE_CLEARUP ({ commit }) {
    ipcRenderer.on('mt::print-service-clearup', e => {
      bus.$emit('print-service-clearup');
    });
  },

  LINTEN_FOR_SET_LINE_ENDING ({ commit, dispatch, state }) {
    ipcRenderer.on('mt::set-line-ending', (e, lineEnding) => {
      const { lineEnding: oldLineEnding } = state.currentFile;
      if (lineEnding !== oldLineEnding) {
        commit('SET_LINE_ENDING', lineEnding);
        commit('SET_ADJUST_LINE_ENDING_ON_SAVE', lineEnding !== 'lf');
        commit('SET_SAVE_STATUS', true);

        // Update menu when emitted from renderer process.
        if (!e) {
          dispatch('UPDATE_LINE_ENDING_MENU');
        }
      }
    });
  },

  LINTEN_FOR_SET_ENCODING ({ commit, state }) {
    ipcRenderer.on('mt::set-file-encoding', (e, encodingName) => {
      const { encoding } = state.currentFile.encoding;
      if (encoding !== encodingName) {
        commit('SET_FILE_ENCODING_BY_NAME', encodingName);
        commit('SET_SAVE_STATUS', true);
      }
    });
  },

  LINTEN_FOR_SET_FINAL_NEWLINE ({ commit, state }) {
    ipcRenderer.on('mt::set-final-newline', (e, value) => {
      const { trimTrailingNewline } = state.currentFile;
      if (trimTrailingNewline !== value) {
        commit('SET_FINAL_NEWLINE', value);
        commit('SET_SAVE_STATUS', true);
      }
    });
  },

  LISTEN_FOR_FILE_CHANGE ({ commit, state, rootState }) {
    ipcRenderer.on('mt::update-file', (e, { type, change }) => {
      // TODO: We should only load the changed content if the user want to reload the document.
      // TODO: 如果用户想要重新加载文档，我们应该只加载更改的内容。

      const { tabs } = state;
      const { pathname } = change;
      const tab = tabs.find(t => isSamePathSync(t.pathname, pathname));
      if (tab) {
        const { id, isSaved, filename } = tab;
        switch (type) {
          case 'unlink': {
            commit('SET_SAVE_STATUS_BY_TAB', { tab, status: false });
            commit('PUSH_TAB_NOTIFICATION', {
              tabId: id,
              msg: `"${filename}" has been removed on disk.`,
              style: 'warn',
              showConfirm: false,
              exclusiveType: 'file_changed'
            });
            break;
          }
          case 'add':
          case 'change': {
            const { autoSave } = rootState.preferences;
            if (autoSave) {
              if (autoSaveTimers.has(id)) {
                const timer = autoSaveTimers.get(id);
                clearTimeout(timer);
                autoSaveTimers.delete(id);
              }

              // Only reload the content if the tab is saved.
              if (isSaved) {
                commit('LOAD_CHANGE', change);
                return;
              }
            }

            commit('SET_SAVE_STATUS_BY_TAB', { tab, status: false });
            commit('PUSH_TAB_NOTIFICATION', {
              tabId: id,
              msg: `"${filename}" has been changed on disk. Do you want to reload it?`,
              showConfirm: true,
              exclusiveType: 'file_changed',
              action: status => {
                if (status) {
                  commit('LOAD_CHANGE', change);
                }
              }
            });
            break;
          }
          default:
            console.error(`LISTEN_FOR_FILE_CHANGE: Invalid type "${type}"`);
        }
      } else {
        console.error(`LISTEN_FOR_FILE_CHANGE: Cannot find tab for path "${pathname}".`);
      }
    });
  },

  ASK_FOR_IMAGE_PATH ({ commit }) {
    return ipcRenderer.sendSync('mt::ask-for-image-path');
  },

  LISTEN_WINDOW_ZOOM ({ dispatch, rootState }) {
    ipcRenderer.on('mt::window-zoom', (e, zoomFactor) => {
      zoomFactor = Number.parseFloat(zoomFactor.toFixed(3)); // prevent float rounding errors
      const { zoom } = rootState.preferences;
      if (zoom !== zoomFactor) {
        dispatch('SET_SINGLE_PREFERENCE', { type: 'zoom', value: zoomFactor });
      }
      webFrame.setZoomFactor(zoomFactor);
    });
  },

  LISTEN_FOR_RELOAD_IMAGES () {
    ipcRenderer.on('mt::invalidate-image-cache', () => {
      bus.$emit('invalidate-image-cache');
    });
  },

  LISTEN_FOR_CONTEXT_MENU () {
    // General context menu
    // 通用上下文菜单
    ipcRenderer.on('mt::cm-copy-as-markdown', () => {
      bus.$emit('copyAsMarkdown', 'copyAsMarkdown');
    });
    ipcRenderer.on('mt::cm-copy-as-html', () => {
      bus.$emit('copyAsHtml', 'copyAsHtml');
    });
    ipcRenderer.on('mt::cm-paste-as-plain-text', () => {
      bus.$emit('pasteAsPlainText', 'pasteAsPlainText');
    });
    ipcRenderer.on('mt::cm-insert-paragraph', (e, location) => {
      bus.$emit('insertParagraph', location);
    });

    // Spelling
    // 拼写
    ipcRenderer.on('mt::spelling-replace-misspelling', (e, info) => {
      bus.$emit('replace-misspelling', info);
    });
    ipcRenderer.on('mt::spelling-show-switch-language', () => {
      bus.$emit('open-command-spellchecker-switch-language');
    });
  }
};

// ----------------------------------------------------------------------------

/**
 * Return the opened root folder or an empty string.
 * 返回打开的根文件夹或空字符串。
 *
 * @param {*} rootState The root state.
 */
const getRootFolderFromState = rootState => {
  const openedFolder = rootState.project.projectTree;
  if (openedFolder) {
    return openedFolder.pathname;
  }
  return '';
};

/**
 * Trim the final newlines according `trimTrailingNewlineOption`.
 * 根据 `trimTrailingNewlineOption` 修剪最后的换行符。
 *
 * @param {string} markdown The text to trim.要修剪的文本。
 * @param {*} trimTrailingNewlineOption The option how we should trim the final newlines.我们应该如何修剪最终换行符的选项。
 */
const adjustTrailingNewlines = (markdown, trimTrailingNewlineOption) => {
  if (!markdown) {
    return '';
  }

  switch (trimTrailingNewlineOption) {
    // Trim trailing newlines.
    // 修剪尾随换行符。
    case 0: {
      return trimTrailingNewlines(markdown);
    }
    // Ensure single trailing newline.
    // 确保单个尾随换行符。
    case 1: {
      // Muya will always add a final new line to the markdown text. Check first whether
      // only one newline exist to prevent copying the string.
      // Muya 将始终在 markdown 文本中添加最后一个新行。 先检查是否
      // 只存在一个换行符以防止复制字符串。
      const lastIndex = markdown.length - 1;
      if (markdown[lastIndex] === '\n') {
        if (markdown.length === 1) {
          // Just return nothing because adding a final new line makes no sense.
          // 什么都不返回，因为添加最后的新行没有意义。
          return '';
        } else if (markdown[lastIndex - 1] !== '\n') {
          return markdown;
        }
      }

      // Otherwise trim trailing newlines and add one.
      // 否则修剪尾随换行符并添加一个
      markdown = trimTrailingNewlines(markdown);
      if (markdown.length === 0) {
        // Just return nothing because adding a final new line makes no sense.
        // 什么都不返回，因为添加最后的新行没有意义。
        return '';
      }
      return markdown + '\n';
    }
    // Disabled, use text as it is.
    // 禁用，按原样使用文本。
    default:
      return markdown;
  }
};

/**
 * Trim trailing newlines from `text`.
 * 修剪来自 `text` 的尾随换行符。
 *
 * @param {string} text The text to trim.要修剪的文本。
 */
const trimTrailingNewlines = text => {
  return text.replace(/[\r?\n]+$/, '');
};

/**
 * Creates a object that contains the application menu state.
 * 创建一个包含应用程序菜单状态的对象。
 *
 * @param {*} selection The selection.
 * @returns A object that represents the application menu state.表示应用程序菜单状态的对象。
 */
const createApplicationMenuState = ({ start, end, affiliation }) => {
  const state = {
    isDisabled: false,
    // Whether multiple lines are selected.是否选择多行。
    isMultiline: start.key !== end.key,
    // List information - a list must be selected.列表信息 - 必须选择一个列表。
    isLooseListItem: false,
    isTaskList: false,
    // Whether the selection is code block like (math, html or code block).选择是否是代码块（数学、html 或代码块）。
    isCodeFences: false,
    // Whether a code block line is selected.是否选择了代码块行。
    isCodeContent: false,
    // Whether the selection contains a table.选择是否包含表格。
    isTable: false,
    // Contains keys about the selection type(s) (string, boolean) like "ul: true".包含有关选择类型（字符串、布尔值）的键，例如“ul: true”。
    affiliation: {}
  };
  const { isMultiline } = state;

  // Get code block information from selection.从选择中获取代码块信息。
  if (
    (start.block.functionType === 'cellContent' && end.block.functionType === 'cellContent') ||
    (start.type === 'span' && start.block.functionType === 'codeContent') ||
    (end.type === 'span' && end.block.functionType === 'codeContent')
  ) {
    // A code block like block is selected (code, math, ...).选择了类似块的代码块（代码，数学，...）。
    state.isCodeFences = true;

    // A code block line is selected.选择了一个代码块行。
    if (start.block.functionType === 'codeContent' || end.block.functionType === 'codeContent') {
      state.isCodeContent = true;
    }
  }

  // Query list information.查询列表信息。
  if (affiliation.length >= 1 && /ul|ol/.test(affiliation[0].type)) {
    const listBlock = affiliation[0];
    state.affiliation[listBlock.type] = true;
    state.isLooseListItem = listBlock.children[0].isLooseListItem;
    state.isTaskList = listBlock.listType === 'task';
  } else if (affiliation.length >= 3 && affiliation[1].type === 'li') {
    const listItem = affiliation[1];
    const listType = listItem.listItemType === 'order' ? 'ol' : 'ul';
    state.affiliation[listType] = true;
    state.isLooseListItem = listItem.isLooseListItem;
    state.isTaskList = listItem.listItemType === 'task';
  }

  // Search with block depth 3 (e.g. "ul -> li -> p" where p is the actually paragraph inside the list (item)).
  // 使用块深度 3 进行搜索（例如“ul -> li -> p”，其中 p 是列表（项目）中的实际段落）。
  for (const b of affiliation.slice(0, 3)) {
    if (b.type === 'pre' && b.functionType) {
      if (/frontmatter|html|multiplemath|code$/.test(b.functionType)) {
        state.isCodeFences = true;
        state.affiliation[b.functionType] = true;
      }
      break;
    } else if (b.type === 'figure' && b.functionType) {
      if (b.functionType === 'table') {
        state.isTable = true;
        state.isDisabled = true;
      }
      break;
    } else if (isMultiline && /^h{1,6}$/.test(b.type)) {
      // Multiple block elements are selected.选择了多个块元素。
      state.affiliation = {};
      break;
    } else {
      if (!state.affiliation[b.type]) {
        state.affiliation[b.type] = true;
      }
    }
  }

  // Clean up
  if (Object.getOwnPropertyNames(state.affiliation).length >= 2 && state.affiliation.p) {
    delete state.affiliation.p;
  }
  if ((state.affiliation.ul || state.affiliation.ol) && state.affiliation.li) {
    delete state.affiliation.li;
  }
  return state;
};

/**
 * Creates a object that contains the formats selection state.创建一个包含格式选择状态的对象。
 *
 * @param {*} selection The selection.
 * @returns A object that represents the formats menu state.表示格式菜单状态的对象。
 */
const createSelectionFormatState = formats => {
  // NOTE: Normally only one format can be selected but the selection is
  // given as array by Muya.
  // 注意：通常只能选择一种格式，但选择是
  // Muya 以数组形式给出。
  const state = {};
  for (const item of formats) {
    state[item.type] = true;
  }
  return state;
};

export default { state, mutations, actions };
