// Run against the production preview on port 4173. Uses synthetic data only.
// PLAYWRIGHT_MODULE may point to an external Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const out = path.resolve(__dirname, '../../docs/ui-preview');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let fields = Object.fromEntries(
    ['day_events', 'day_meals', 'day_plan', 'evening_summary'].map((f) => [
      f,
      { value: '', updatedAt: null },
    ]),
  );
  const entry = () => ({ entryDate: '2026-09-20', exists: true, version: 1, fields });
  const settings = {
    timezone: 'Asia/Shanghai',
    day_start_hour: 4,
    reminders: {
      morning_enabled: true,
      morning_time: '09:00',
      evening_enabled: true,
      evening_time: '21:00',
      only_if_incomplete: true,
    },
    quiet_hours: { enabled: false, start: '23:00', end: '07:00' },
    push: { vapid_public_key: null, subscriptions: 0 },
  };
  const patches = [];
  let firstPatchResolve;
  const firstPatch = new Promise((r) => (firstPatchResolve = r));
  let releaseFirst;
  const held = new Promise((r) => (releaseFirst = r));
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    let body = {};
    if (url.pathname === '/v1/diaries/today')
      body = {
        meta: {
          diary_date: '2026-09-20',
          yesterday: '2026-09-19',
          timezone: 'Asia/Shanghai',
          day_start_hour: 4,
          user_id: 'preview-user',
          server_time: new Date().toISOString(),
        },
        today: entry(),
        yesterday: entry(),
        incidents: [],
        progress: { morningDone: !!fields.day_plan.value, eveningDone: false },
      };
    else if (req.method() === 'PATCH' && url.pathname.startsWith('/v1/diaries/')) {
      const payload = req.postDataJSON();
      patches.push(payload);
      if (patches.length === 1) {
        firstPatchResolve();
        await held;
      }
      const result = {};
      for (const [f, p] of Object.entries(payload.fields)) {
        fields[f] = { value: p.value, updatedAt: new Date().toISOString() };
        result[f] = { ...fields[f], overwritten: false };
      }
      body = { entryDate: '2026-09-20', version: patches.length, fields: result };
    } else if (url.pathname.startsWith('/v1/diaries/')) body = { entry: entry(), incidents: [] };
    else if (url.pathname === '/v1/settings') body = settings;
    else if (url.pathname === '/v1/calendar')
      body = {
        month: '2026-09',
        days: [3, 5, 8, 11, 12, 16, 18, 20].map((d) => ({
          date: `2026-09-${String(d).padStart(2, '0')}`,
          hasContent: true,
          incidentCount: d % 3,
        })),
      };
    else if (url.pathname === '/v1/meta/timezones') body = { timezones: ['Asia/Shanghai', 'UTC'] };
    else if (url.pathname === '/v1/notifications/status')
      body = {
        vapid_public_key: null,
        push_configured: false,
        subscriptions: [],
        recent_deliveries: [],
        reminders: { morning_time: '09:00', evening_time: '21:00' },
      };
    await route.fulfill({ json: body });
  });
  await page.route('**/healthz', (r) =>
    r.fulfill({ json: { status: 'ok', db: 'ok', time: new Date().toISOString() } }),
  );
  await page.goto('http://127.0.0.1:4173');
  await page.screenshot({ path: out + '/login-desktop.png', fullPage: true });
  await page.evaluate(() => {
    localStorage.setItem(
      'daybook.session.v1',
      JSON.stringify({
        user: { id: 'preview-user', username: 'Lin' },
        accessToken: 'preview',
        refreshToken: 'preview',
        expiresAt: Date.now() + 3600000,
        refreshExpiresAt: '2026-10-01',
      }),
    );
  });
  await page.reload();
  await page.locator('textarea').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea').disabled);
  await page.screenshot({ path: out + '/today-desktop.png', fullPage: true });
  const input = page.locator('textarea').first();
  await input.fill('A');
  await firstPatch;
  await input.fill('AB，慢下来，读几页书。');
  releaseFirst();
  await page.waitForFunction(() => document.body.textContent.includes('已保存'));
  assert.equal(patches.at(-1).fields.day_plan.value, 'AB，慢下来，读几页书。');
  assert.equal(await input.inputValue(), 'AB，慢下来，读几页书。');
  await page.reload();
  await page.waitForFunction(() => document.body.textContent.includes('AB，慢下来，读几页书。'));
  await page.getByRole('link', { name: '日历 回看走过的日子' }).click();
  await page.locator('.calendar-day').first().waitFor();
  await page.screenshot({ path: out + '/calendar-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4173/#/today');
  await page.getByRole('button', { name: '展开 / 修改' }).click();
  await page.screenshot({ path: out + '/today-mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '记录此刻' }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: out + '/incident-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.goto('http://127.0.0.1:4173/#/settings');
  await page.getByText('时区', { exact: true }).first().waitFor();
  await page.screenshot({ path: out + '/settings-mobile.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://127.0.0.1:4173/#/today');
  await page.locator('.incident-card').waitFor();
  await page.screenshot({ path: out + '/today-dark-mobile.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('daybook', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({
        key: 'preview-user:2026-09-20:day_plan',
        userId: 'preview-user',
        entryDate: '2026-09-20',
        field: 'day_plan',
        value: '这是一份断网时写下的新草稿。',
        modifiedAt: Date.now(),
        revision: 'browser-recovery',
        baseUpdatedAt: 'older-server-version',
      });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
  });
  await page.reload();
  await page.getByRole('button', { name: '恢复本机草稿' }).waitFor();
  await page.screenshot({ path: out + '/draft-recovery-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '恢复本机草稿' }).click();
  await page.waitForFunction(() => document.body.textContent.includes('已保存'));
  assert.equal(patches.at(-1).fields.day_plan.value, '这是一份断网时写下的新草稿。');
  await page.setViewportSize({ width: 320, height: 720 });
  for (const route of ['today', 'calendar/2026-09', 'settings']) {
    await page.goto('http://127.0.0.1:4173/#/' + route);
    await page.locator('.app-main').waitFor();
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow ' + route,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: desktop/mobile/dark screens, calendar/settings/modal, no overflow or page errors, slow network saves AB and survives reload.',
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
