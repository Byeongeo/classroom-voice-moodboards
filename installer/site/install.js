const $ = id => document.getElementById(id);
const form = $('install-form');
const token = $('token');
const account = $('account');
const teacher = $('teacher');
const openrouter = $('openrouter');
const installStatus = $('install-status');
const progress = $('progress');

function showPath() {
  const path = location.hash.slice(1);
  const chosen = path === 'existing' || path === 'new';
  for (const option of ['existing', 'new']) {
    $(option).hidden = path !== option;
    $('choose-' + option).setAttribute('aria-current', String(path === option));
  }
  $('prepare').hidden = !chosen;
  $('deploy').hidden = !chosen;
  if (chosen) $(path).scrollIntoView({ block: 'nearest' });
}

window.addEventListener('hashchange', showPath);
showPath();

const template = new URL('https://dash.cloudflare.com/profile/api-tokens');
template.search = new URLSearchParams({
  permissionGroupKeys: JSON.stringify([
    { key: 'account_settings', type: 'read' },
    ...['workers_scripts', 'workers_r2', 'd1', 'queues'].map(key => ({ key, type: 'edit' })),
  ]),
  accountId: '*',
  zoneId: 'all',
  name: 'Voice Classroom Browser Install',
});
$('token-link').href = template;

function updateR2Link() {
  if (/^[a-f0-9]{32}$/.test(account.value)) {
    $('r2-link').href = 'https://dash.cloudflare.com/' + account.value + '/r2/overview';
  } else {
    $('r2-link').href = 'https://dash.cloudflare.com/?to=/:account/r2/overview';
  }
}
account.addEventListener('change', updateR2Link);

async function post(path, payload) {
  const response = await fetch('/api/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.message || '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  return response;
}

function clearAccounts() {
  account.replaceChildren();
  $('account-fields').hidden = true;
  $('account-fields').disabled = true;
  $('account-status').textContent = '';
  updateR2Link();
}
token.addEventListener('input', clearAccounts);

async function checkAccount() {
  const value = token.value.trim();
  if (!value) { token.reportValidity(); return; }
  clearAccounts();
  const button = $('check-account');
  button.disabled = true;
  const status = $('account-status');
  status.textContent = 'Cloudflare 계정을 확인하는 중입니다.';
  try {
    const { accounts } = await (await post('accounts', { token: value })).json();
    if (token.value.trim() !== value) return;
    if (!accounts.length) throw new Error('설치할 계정이 없습니다. 이메일 인증과 토큰의 계정 범위를 확인하세요.');
    if (accounts.length > 1) account.add(new Option('설치할 계정을 선택하세요', ''));
    for (const item of accounts) account.add(new Option(item.name, item.id));
    $('account-fields').hidden = false;
    $('account-fields').disabled = false;
    updateR2Link();
    status.textContent = accounts.length === 1 ? '계정을 확인했습니다. 아래 정보를 입력하세요.' : '여러 계정이 있습니다. 설치할 계정 하나를 선택하세요.';
  } catch (error) {
    if (token.value.trim() === value) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
$('check-account').addEventListener('click', checkAccount);
token.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!$('check-account').disabled) void checkAccount();
  }
});

function showPassword(visible) {
  teacher.type = visible ? 'text' : 'password';
  $('show-password').textContent = visible ? '가리기' : '보기';
  $('show-password').setAttribute('aria-pressed', String(visible));
}
$('show-password').addEventListener('click', () => showPassword(teacher.type === 'password'));
$('generate-password').addEventListener('click', () => {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  teacher.value = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => letters[n % letters.length]).join('');
  showPassword(true);
});

function showResult(event) {
  const url = new URL(event.url);
  if (url.protocol !== 'https:' || !/^voice-classroom-[a-f0-9]{16}\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)) {
    throw new Error('설치 주소를 확인할 수 없습니다.');
  }
  form.reset();
  showPassword(false);
  form.hidden = true;
  clearAccounts();
  $('student-url').value = url.href;
  $('student-link').href = url.href;
  $('teacher-link').href = new URL('?login=teacher', url).href;
  $('result-status').textContent = event.verified
    ? '앱 주소가 응답하는 것을 확인했습니다.'
    : 'Cloudflare에서 앱을 배포했습니다. 링크가 아직 안 열리면 1~2분 뒤 새로고침하세요.';
  $('result').hidden = false;
  $('result-title').focus();
}

async function followProgress(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === 'error') {
        const note = event.resourcePrefix ? ' Cloudflare 대시보드에서 이번 시도 이름 ' + event.resourcePrefix + '으로 남은 리소스가 있는지 확인하세요.' : '';
        throw new Error(event.message + note);
      }
      if (event.type === 'done') {
        showResult(event);
        installStatus.textContent = '앱 설치 완료';
        progress.value = progress.max;
        return;
      }
      progress.value = event.step;
      installStatus.textContent = event.message;
    }
  }
  throw new Error('연결이 끊겼습니다. 앱이 이미 만들어졌을 수 있으니 Cloudflare의 Workers & Pages를 먼저 확인해 주세요.');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if ($('account-fields').disabled || $('fields').disabled) return;
  const payload = { token: token.value.trim(), account: account.value, openRouterKey: openrouter.value.trim(), teacherPassword: teacher.value };
  $('fields').disabled = true;
  progress.hidden = false;
  progress.value = 0;
  installStatus.classList.remove('error');
  installStatus.textContent = '설치 요청을 보내고 있습니다. 이 탭을 열어 두세요.';
  try {
    await followProgress(await post('install', payload));
  } catch (error) {
    progress.hidden = true;
    installStatus.classList.add('error');
    installStatus.textContent = error.message;
  } finally {
    $('fields').disabled = false;
  }
});

$('copy-url').addEventListener('click', async () => {
  const field = $('student-url');
  try {
    await navigator.clipboard.writeText(field.value);
    $('copy-status').textContent = '학생 주소를 복사했습니다.';
  } catch {
    field.select();
    $('copy-status').textContent = 'Ctrl+C를 눌러 선택한 주소를 복사하세요.';
  }
});
