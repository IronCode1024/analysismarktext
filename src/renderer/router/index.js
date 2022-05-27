import App from '@/pages/app'
import Preference from '@/pages/preference'
import General from '@/prefComponents/general'
import Editor from '@/prefComponents/editor'
import Markdown from '@/prefComponents/markdown'
import SpellChecker from '@/prefComponents/spellchecker'
import Theme from '@/prefComponents/theme'
import Image from '@/prefComponents/image'
import Keybindings from '@/prefComponents/keybindings'

const parseSettingsPage = type => {
  let pageUrl = '/preference'
  if (/\/spelling$/.test(type)) {
    pageUrl += '/spelling'
  }
  return pageUrl
}

const routes = type => ([{
  path: '/', redirect: type === 'editor' ? '/editor' : parseSettingsPage(type)
}, {
  path: '/editor', component: App
}, {
  path: '/preference',
  component: Preference,
  children: [{
    path: '', component: General
  }, {
    path: 'general', component: General, name: 'general'
  }, {
    path: 'editor', component: Editor, name: 'editor'
  }, {
    path: 'markdown', component: Markdown, name: 'markdown'
  }, {
    path: 'spelling', component: SpellChecker, name: 'spelling'
  }, {
    path: 'theme', component: Theme, name: 'theme'
  }, {
    path: 'image', component: Image, name: 'image'
  }, {
    path: 'keybindings', component: Keybindings, name: 'keybindings'
  }]
}])

export default routes
