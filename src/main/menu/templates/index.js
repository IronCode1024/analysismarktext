import edit from './edit'
import prefEdit from './prefEdit'
import file from './file'
import help from './help'
import marktext from './marktext'
import view from './view'
import window from './window'
import paragraph from './paragraph'
import format from './format'
import theme from './theme'

export dockMenu from './dock'

/**
 * Create the setting window menu.
 *
 * @param {Keybindings} keybindings The keybindings instance
 */
export const configSettingMenu = (keybindings) => {
  return [
    ...(process.platform === 'darwin' ? [marktext(keybindings)] : []),
    prefEdit(keybindings),
    help()
  ]
}

/**
 * Create the application menu for the editor window. 为编辑器窗口创建应用程序菜单.
 *
 * @param {Keybindings} keybindings The keybindings instance. 为Keybindings实例
 * @param {Preference} preferences The preference instance.首选项首选项实例
 * @param {string[]} recentlyUsedFiles The recently used files.最近使用的文件将对最近使用的文件进行归档。
 */
export default function (keybindings, preferences, recentlyUsedFiles) {
  return [
    ...(process.platform === 'darwin' ? [marktext(keybindings)] : []),
    file(keybindings, preferences, recentlyUsedFiles),
    edit(keybindings),
    paragraph(keybindings),
    format(keybindings),
    window(keybindings),
    theme(preferences),
    view(keybindings),
    help()
  ]
}
