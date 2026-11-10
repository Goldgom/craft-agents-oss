'use strict'
const serverField = document.getElementById('server')
const tokenField = document.getElementById('token')
const workspaceField = document.getElementById('workspace')
const rememberField = document.getElementById('remember')
const button = document.getElementById('connect')
const errorText = document.getElementById('error')
const updateWarning = () => { document.getElementById('warning').hidden = !/^(ws|http):\/\//i.test(serverField.value.trim()) }
serverField.addEventListener('input', updateWarning)
window.TokenBirdRemote.getConnection().then(config => {
  serverField.value = config.serverUrl || ''
  tokenField.value = config.token || ''
  workspaceField.value = config.workspaceId || ''
  rememberField.checked = Boolean(config.rememberToken)
  updateWarning()
}).catch(error => { errorText.textContent = error.message })
document.getElementById('connection').addEventListener('submit', async event => {
  event.preventDefault()
  errorText.textContent = ''
  button.disabled = true
  try {
    await window.TokenBirdRemote.connect({ serverUrl: serverField.value, token: tokenField.value, workspaceId: workspaceField.value, rememberToken: rememberField.checked })
  } catch (error) {
    errorText.textContent = error.message
    button.disabled = false
  }
})
