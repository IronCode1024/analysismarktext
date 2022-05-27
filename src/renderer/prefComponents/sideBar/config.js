import GeneralIcon from '@/assets/icons/pref_general.svg'
import EditorIcon from '@/assets/icons/pref_editor.svg'
import MarkdownIcon from '@/assets/icons/pref_markdown.svg'
import ThemeIcon from '@/assets/icons/pref_theme.svg'
import ImageIcon from '@/assets/icons/pref_image.svg'
import SpellIcon from '@/assets/icons/pref_spellcheck.svg'
import KeyBindingIcon from '@/assets/icons/pref_key_binding.svg'

import preferences from '../../../main/preferences/schema'

export const category = [{
  name: 'General',
  label: 'general',
  icon: GeneralIcon,
  path: '/preference/general'
}, {
  name: 'Editor',
  label: 'editor',
  icon: EditorIcon,
  path: '/preference/editor'
}, {
  name: 'Markdown',
  label: 'markdown',
  icon: MarkdownIcon,
  path: '/preference/markdown'
}, {
  name: 'Spelling',
  label: 'spelling',
  icon: SpellIcon,
  path: '/preference/spelling'
}, {
  name: 'Theme',
  label: 'theme',
  icon: ThemeIcon,
  path: '/preference/theme'
}, {
  name: 'Image',
  label: 'image',
  icon: ImageIcon,
  path: '/preference/image'
}, {
  name: 'Key Bindings',
  label: 'keybindings',
  icon: KeyBindingIcon,
  path: '/preference/keybindings'
}]

export const searchContent = Object.keys(preferences).map(k => {
  const { description, enum: emums } = preferences[k]
  let [category, preference] = description.split('--')
  if (Array.isArray(emums)) {
    preference += ` optional values: ${emums.join(', ')}`
  }
  return {
    category,
    preference
  }
})
  .filter(({ category: ca }) => category.some(c => c.label === ca.toLowerCase()))
