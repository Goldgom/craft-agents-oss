'use strict'
const field = name => document.getElementById(name)
window.TokenBirdLocal.getProfile().then(profile => {
  for (const name of ['api', 'baseUrl', 'model', 'workingDirectory']) field(name).value = profile[name]
  if (profile.hasStoredKey) field('apiKey').placeholder = '已保存；留空保留，填写新 Key 则替换'
}).catch(error => { field('error').textContent = error.message })
field('choose').onclick = async () => {
  const directory = await window.TokenBirdLocal.chooseDirectory()
  if (directory) field('workingDirectory').value = directory
}
field('form').onsubmit = async event => {
  event.preventDefault()
  field('save').disabled = true
  field('error').textContent = ''
  try {
    const input = Object.fromEntries(['api', 'baseUrl', 'model', 'apiKey', 'workingDirectory'].map(name => [name, field(name).value]))
    await window.TokenBirdLocal.configure(input)
    field('apiKey').value = ''
  } catch (error) { field('error').textContent = error.message; field('save').disabled = false }
}
