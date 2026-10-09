import { randomBytes } from 'node:crypto'

// Embedded in both the standalone executable and Docker bundle.
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>词元鸟 · 云端管理</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#263342;background:#f3f5f7;line-height:1.5;color-scheme:light}
*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer;border:1px solid #d6dce3;border-radius:8px;padding:8px 14px;background:white;color:#263342}button:hover{background:#eef2f6}button:disabled{opacity:.5;cursor:wait}.primary{background:#263342;color:white;border-color:#263342}.primary:hover{background:#3b4e62}.danger{color:#b63a31}input{border:1px solid #d6dce3;border-radius:8px;padding:10px 12px;min-width:0;background:#fff;color:#263342}input:focus,button:focus-visible{outline:2px solid #d5a854;outline-offset:2px}h1,h2,p{margin:0}h1{font-size:23px;letter-spacing:-.5px}h2{font-size:18px}small,.muted{color:#697789}small{display:block}header{background:#fff;border-bottom:1px solid #e1e6eb;padding:18px 32px;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;gap:12px;align-items:center}.logo{display:grid;place-items:center;width:40px;height:40px;background:#fff3d9;border-radius:12px;font-size:24px;color:#916317}main{max-width:1440px;margin:auto;padding:28px 32px}#login{max-width:430px;margin:70px auto;padding:30px;background:#fff;border:1px solid #e1e6eb;border-radius:16px}#login p{margin:10px 0 24px}#login input{width:100%;margin:8px 0 20px}#login button{width:100%}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px;flex-wrap:wrap}.toolbar nav{display:flex;gap:8px}.tab.active{background:#263342;color:#fff;border-color:#263342}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}.stat,.panel{background:white;border:1px solid #e1e6eb;border-radius:12px}.stat{padding:18px 20px}.stat strong{display:block;font-size:28px;margin-top:4px}.panel{margin-bottom:24px;overflow:hidden}.panel-head{padding:20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.panel-head p{font-size:13px;margin-top:5px;color:#697789}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:14px}th{font-size:12px;font-weight:600;color:#697789;background:#f8fafb}th,td{padding:13px 20px;border-top:1px solid #edf0f3;vertical-align:middle}td small{font-size:12px;overflow-wrap:anywhere}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{font-size:12px;padding:5px 9px;white-space:nowrap}.badge{font-size:12px;white-space:nowrap;border-radius:6px;padding:4px 8px;background:#edf1f4;color:#657184}.badge.online{background:#e7f5ed;color:#25734c}.badge.blocked{background:#fff0ec;color:#b63a31}.pager{display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:14px 20px;border-top:1px solid #edf0f3;font-size:13px}.empty{padding:30px;color:#697789;text-align:center}.rate-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:24px}.form-body{padding:0 24px 24px}.field{display:grid;grid-template-columns:1fr 170px;gap:8px 24px;padding:18px 0;border-top:1px solid #edf0f3}.field label{font-weight:600;font-size:14px}.field small{margin-top:4px;font-weight:400}.field input{width:100%;align-self:center}.save-row{display:flex;gap:12px;align-items:center;padding-top:20px}.note{padding:24px;font-size:14px}.note p{margin:12px 0;color:#697789}#notice{padding:12px 16px;margin:0 0 20px;background:#e7f5ed;color:#25734c;border-radius:8px;font-size:14px}#notice.error{background:#fff0ec;color:#b63a31}#login-error{color:#b63a31;margin-top:14px;font-size:14px}.refresh-info{font-size:12px;color:#697789}.right{display:flex;align-items:center;gap:12px}[hidden]{display:none!important}@media(max-width:800px){header{padding:16px}main{padding:20px 16px}.stats{grid-template-columns:repeat(2,1fr)}.rate-layout{grid-template-columns:1fr}.field{grid-template-columns:1fr}.panel-head{padding:16px}th,td{padding:12px 16px}.refresh-info{display:none}h1{font-size:20px}#login{margin:35px auto}#search{width:100%}}
</style></head><body>
<header><div class="brand"><div class="logo" aria-hidden="true">◈</div><div><h1>词元鸟 · 云端管理</h1><small>连接状态与访问流量</small></div></div><button id="logout" hidden>退出登录</button></header>
<main>
<section id="login"><h2>登录管理后台</h2><p class="muted">输入服务器配置中的独立管理密钥。</p><form id="login-form"><label for="admin-key">管理密钥</label><input id="admin-key" type="password" autocomplete="current-password" required minlength="32"><button class="primary" type="submit">登录</button><div id="login-error" role="alert"></div></form></section>
<div id="dashboard" hidden>
<div class="toolbar"><nav aria-label="管理栏目"><button class="tab active" data-tab="connections">连接管理</button><button class="tab" data-tab="limits">限流管理</button></nav><div class="right"><span id="updated" class="refresh-info"></span><button id="refresh">刷新</button></div></div>
<div id="notice" role="status" hidden></div>
<div class="stats"><div class="stat"><small>在线设备</small><strong id="stat-hosts">0</strong></div><div class="stat"><small>访问连接</small><strong id="stat-clients">0</strong></div><div class="stat"><small>转发流量 · 本次运行</small><strong id="stat-bytes">0 B</strong></div><div class="stat"><small>限流拦截 · 本次运行</small><strong id="stat-rejected">0</strong></div></div>
<section id="connections-section">
<div class="panel"><div class="panel-head"><div><h2>设备列表</h2><p>断开允许自动重连；撤销需主机重新启用；封禁由管理员解除。</p></div><form id="search-form"><input id="search" placeholder="搜索设备名、账户或设备 ID" aria-label="搜索设备"><button type="submit">搜索</button></form></div><div class="table-wrap"><table><thead><tr><th>设备 / ID</th><th>账户</th><th>状态</th><th>访问连接</th><th>最后心跳</th><th>管理操作</th></tr></thead><tbody id="devices"></tbody></table></div><div class="pager"><span id="page-info"></span><button id="previous">上一页</button><button id="next">下一页</button></div></div>
<div class="panel"><div class="panel-head"><div><h2>当前连接</h2><p>包含主机隧道与访问端连接。等待握手的连接也计入连接上限。</p></div><span class="muted" id="connection-count"></span></div><div class="table-wrap"><table><thead><tr><th>连接 / 设备</th><th>账户</th><th>类型</th><th>建立时间</th><th>授权到期</th><th>操作</th></tr></thead><tbody id="connection-rows"></tbody></table></div><div class="pager"><span id="connection-page-info"></span><button id="connection-previous">上一页</button><button id="connection-next">下一页</button></div></div>
</section>
<section id="limits-section" hidden><div class="rate-layout"><form class="panel" id="limits-form"><div class="panel-head"><div><h2>限流配置</h2><p>保存后立即生效，并在服务器重启后保留。</p></div></div><div class="form-body">
<div class="field"><label for="apiRequestsPerMinute">API 请求 / 分钟<small>按 TokenNest 账户和凭据分别计数，包含登记、心跳与共享操作。网站服务接口单独共用此配额。</small></label><input id="apiRequestsPerMinute" name="apiRequestsPerMinute" type="number" min="1" max="1000000" step="1" required></div>
<div class="field"><label for="maxHosts">在线设备上限<small>全服务器可同时建立的主机隧道数量。</small></label><input id="maxHosts" name="maxHosts" type="number" min="1" max="1000000" step="1" required></div>
<div class="field"><label for="maxClients">访问连接总上限<small>全服务器访问端连接数量，包含等待握手的连接。</small></label><input id="maxClients" name="maxClients" type="number" min="1" max="1000000" step="1" required></div>
<div class="field"><label for="maxClientsPerDevice">单设备访问连接上限<small>同一台设备允许同时接入的访问端数量。</small></label><input id="maxClientsPerDevice" name="maxClientsPerDevice" type="number" min="1" max="1000000" step="1" required></div>
<div class="field"><label for="relayBytesPerSecondPerDevice">单设备转发字节 / 秒<small>上下行共用配额，按收到的隧道消息字节计数（含协议开销）。</small></label><input id="relayBytesPerSecondPerDevice" name="relayBytesPerSecondPerDevice" type="number" min="1" max="1073741824" step="1" required></div>
<div class="save-row"><button class="primary" type="submit">保存配置</button><span id="draft-note" class="muted"></span></div></div></form>
<aside class="panel note"><h2>生效方式</h2><p>请求超过一分钟内配额时返回 429，调用方需等待窗口恢复。</p><p>连接达到上限时拒绝新连接。调低连接上限会立即断开超出的连接，优先保留先建立的连接。</p><p>流量按一秒窗口计数，超限会断开产生该消息的连接。单条消息也必须小于配额，请为文件上传预留空间。</p><p>限流不会影响后台管理和健康检查。运行统计在服务重启后清零。</p><p id="uptime"></p></aside></div></section>
</div></main>
<script nonce="ADMIN_NONCE">
(() => {
  const $ = id => document.getElementById(id);
  let csrf = '', state, page = 1, connectionPage = 1, search = '', draft = false, refreshing = false;
  function notice(message, error = false) { $('notice').hidden = false; $('notice').className = error ? 'error' : ''; $('notice').textContent = message; }
  function showLogin() { csrf = ''; state = undefined; draft = false; $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true; }
  async function api(path, method = 'GET', body) {
    const response = await fetch('/admin/api/' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(result.error || '操作失败'); }
    return result;
  }
  function cell(row, value, detail) { const td = document.createElement('td'); td.textContent = String(value); if (detail) { const small = document.createElement('small'); small.textContent = detail; td.append(small); } row.append(td); return td; }
  function badge(row, label, kind) { const td = cell(row, ''); const span = document.createElement('span'); span.className = 'badge ' + kind; span.textContent = label; td.append(span); }
  function empty(body, columns, text) { const row = document.createElement('tr'); const td = cell(row, text); td.colSpan = columns; td.className = 'empty'; body.append(row); }
  const date = value => value ? new Date(value).toLocaleString() : '—';
  function bytes(value) { if (value < 1024) return value + ' B'; if (value < 1048576) return (value / 1024).toFixed(1) + ' KiB'; if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MiB'; return (value / 1073741824).toFixed(1) + ' GiB'; }
  function action(parent, label, path, method, confirmation, danger = false) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (danger) button.className = 'danger';
    button.onclick = async () => { if (confirmation && !confirm(confirmation)) return; button.disabled = true; try { await api(path, method); notice(label + '成功'); await refresh(); } catch (error) { notice(error.message, true); } finally { button.disabled = false; } };
    parent.append(button);
  }
  function renderConnections() {
    const rows = $('connection-rows'); rows.replaceChildren();
    const pages = Math.max(1, Math.ceil(state.connections.length / 100)); connectionPage = Math.min(connectionPage, pages);
    for (const connection of state.connections.slice((connectionPage - 1) * 100, connectionPage * 100)) {
      const row = document.createElement('tr');
      cell(row, connection.id.slice(0, 8), connection.deviceId); cell(row, connection.owner || '等待认证');
      badge(row, connection.role === 'host' ? '主机隧道' : connection.authenticated ? '访问端' : '等待握手', connection.authenticated ? 'online' : '');
      cell(row, date(connection.openedAt)); cell(row, date(connection.expiresAt));
      const actions = cell(row, ''); actions.className = 'actions';
      action(actions, '断开', 'connections/' + connection.id, 'DELETE', connection.role === 'host' ? '断开主机隧道将关闭此设备的全部访问连接，主机可自动重连。继续？' : '断开此访问连接？', true);
      rows.append(row);
    }
    if (!state.connections.length) empty(rows, 6, '暂无连接');
    $('connection-count').textContent = state.connections.length + ' 个连接';
    $('connection-page-info').textContent = connectionPage + ' / ' + pages;
    $('connection-previous').disabled = connectionPage <= 1; $('connection-next').disabled = connectionPage >= pages;
  }
  function render() {
    $('stat-hosts').textContent = state.stats.hosts; $('stat-clients').textContent = state.stats.clients;
    $('stat-bytes').textContent = bytes(state.stats.relayedBytes);
    $('stat-rejected').textContent = state.stats.rejectedRequests + state.stats.rejectedConnections + state.stats.rejectedFrames;
    const devices = $('devices'); devices.replaceChildren();
    for (const device of state.devices) {
      const row = document.createElement('tr'); cell(row, device.name, device.id); cell(row, device.owner);
      badge(row, device.blocked ? '已封禁' : device.revoked ? '已撤销' : device.online ? '在线' : '离线', device.blocked || device.revoked ? 'blocked' : device.online ? 'online' : '');
      cell(row, device.clients); cell(row, date(device.lastSeen));
      const actions = cell(row, ''); actions.className = 'actions';
      if (device.online) action(actions, '断开', 'devices/' + device.id + '/disconnect', 'POST', '断开此设备及其访问连接？主机可自动重连。');
      if (!device.revoked) action(actions, '撤销', 'devices/' + device.id + '/revoke', 'POST', '撤销此设备的远程访问？需要在主机重新启用才能恢复。', true);
      action(actions, device.blocked ? '解除封禁' : '封禁', 'devices/' + device.id + (device.blocked ? '/unblock' : '/block'), 'POST', device.blocked ? '允许此设备重新连接？原有撤销状态仍保留。' : '封禁此设备？主机重新启用也无法恢复，需管理员解除封禁。', !device.blocked);
      devices.append(row);
    }
    if (!state.devices.length) empty(devices, 6, search ? '没有匹配的设备' : '暂无登记设备');
    const pages = Math.max(1, Math.ceil(state.total / 100));
    $('page-info').textContent = '共 ' + state.total + ' 台 · ' + page + ' / ' + pages;
    $('previous').disabled = page <= 1; $('next').disabled = page >= pages;
    renderConnections();
    if (!draft) for (const [key, value] of Object.entries(state.limits)) $(key).value = value;
    $('draft-note').textContent = draft ? '有未保存的修改' : '';
    $('updated').textContent = '每 10 秒刷新 · ' + new Date().toLocaleTimeString();
    $('uptime').textContent = '服务启动：' + date(state.stats.startedAt);
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const result = await api('state?page=' + page + '&search=' + encodeURIComponent(search)); state = result; csrf = result.csrf;
      $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; render();
    } catch (error) { if ($('dashboard').hidden) $('login-error').textContent = error.message; else notice(error.message, true); }
    finally { refreshing = false; }
  }
  $('login-form').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter || event.target.querySelector('button[type="submit"]'); button.disabled = true; $('login-error').textContent = '';
    try { await api('session', 'POST', { key: $('admin-key').value }); $('admin-key').value = ''; $('notice').hidden = true; await refresh(); }
    catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; }
  };
  $('logout').onclick = async () => { try { await api('session', 'DELETE'); showLogin(); } catch (error) { notice(error.message, true); } };
  $('refresh').onclick = refresh;
  $('search-form').onsubmit = event => { event.preventDefault(); search = $('search').value.trim(); page = 1; refresh(); };
  $('previous').onclick = () => { page--; refresh(); }; $('next').onclick = () => { page++; refresh(); };
  $('connection-previous').onclick = () => { connectionPage--; renderConnections(); }; $('connection-next').onclick = () => { connectionPage++; renderConnections(); };
  $('limits-form').oninput = () => { draft = true; $('draft-note').textContent = '有未保存的修改'; };
  $('limits-form').onsubmit = async event => {
    event.preventDefault();
    if (!confirm('保存并立即应用限流配置？调低连接上限会断开超出的现有连接。')) return;
    const button = event.submitter || event.target.querySelector('button[type="submit"]'); button.disabled = true;
    const limits = {}; for (const [key, value] of new FormData(event.target)) limits[key] = Number(value);
    try { await api('limits', 'PUT', limits); draft = false; notice('限流配置已保存并生效'); await refresh(); }
    catch (error) { notice(error.message, true); } finally { button.disabled = false; }
  };
  for (const tab of document.querySelectorAll('[data-tab]')) tab.onclick = () => {
    for (const item of document.querySelectorAll('[data-tab]')) item.classList.toggle('active', item === tab);
    $('connections-section').hidden = tab.dataset.tab !== 'connections'; $('limits-section').hidden = tab.dataset.tab !== 'limits';
  };
  refresh(); setInterval(() => { if (!$('dashboard').hidden && !document.hidden) refresh(); }, 10000);
})();
</script></body></html>`

export function adminPage(): Response {
  const nonce = randomBytes(24).toString('base64')
  return new Response(html.replace('ADMIN_NONCE', nonce), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
  } })
}
