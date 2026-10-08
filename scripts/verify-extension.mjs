import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

// Runs only against an isolated browser and synthetic page; all model transports are replaced in memory.
const argument = name =>
  process.argv
    .find(value => value.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
let extensionPath = resolve(argument('extension') || 'dist');
const allPhases = process.argv.includes('--all-phases');
const phase2 = allPhases || process.argv.includes('--phase2');
const archivePath = argument('zip');
let archiveSha256;
if (archivePath) {
  const bytes = await readFile(resolve(archivePath));
  archiveSha256 = createHash('sha256').update(bytes).digest('hex');
  const { unzipSync } = await import('fflate');
  await mkdir(resolve('.git/jev-browser-package'), { recursive: true });
  extensionPath = await mkdtemp(resolve('.git/jev-browser-package/run-'));
  for (const [name, contents] of Object.entries(unzipSync(bytes))) {
    const destination = resolve(extensionPath, name);
    const within = relative(extensionPath, destination);
    assert.ok(
      within && !within.startsWith('..') && !isAbsolute(within),
      'ZIP entry must remain inside the isolated extraction directory',
    );
    if (name.endsWith('/')) continue;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}
const reportPath = resolve(argument('report') || '.git/jev-browser-report.json');
const executablePath =
  argument('browser') || process.env.JEV_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'));
await access(executablePath);
await mkdir(resolve('.git/jev-browser-profile'), { recursive: true });
const userDataDir = await mkdtemp(resolve('.git/jev-browser-profile/run-'));
const fixture = `<!doctype html><html><head><title>Jev isolated test</title></head><body>
<h1>Offline decision fixture</h1><button id="commit">Mark complete</button><p id="status">Not complete</p>
<script>window.clicks=0;document.getElementById('commit').onclick=()=>{window.clicks++;document.getElementById('status').textContent='COMPLETED';};</script>
</body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(fixture);
});
await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;
const report = {
  version: manifest.version,
  extensionPath,
  archivePath: archivePath ? resolve(archivePath) : undefined,
  archiveSha256,
  browser: '',
  mode: 'Actual packaged extension pages, service worker and DOM executor; mocked Jev and LLM transport',
  liveJevVerified: false,
  startedAt: new Date().toISOString(),
  tests: [],
};
let browser;
let diagnostics = async () => ({});

async function test(name, run) {
  const start = Date.now();
  try {
    const evidence = await run();
    report.tests.push({ name, status: 'passed', elapsedMs: Date.now() - start, ...evidence });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.tests.push({
      name,
      status: 'failed',
      elapsedMs: Date.now() - start,
      error: error.message,
      diagnostics: await diagnostics(),
    });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    enableExtensions: true,
    userDataDir,
    args: [
      '--enable-unsafe-extension-debugging',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      '--disable-background-networking',
      '--lang=en-US',
    ],
  });
  report.browser = await browser.version();
  const extensionId = await browser.installExtension(extensionPath);
  const extensionUrl = `chrome-extension://${extensionId}`;
  const workerTarget = await browser.waitForTarget(
    target => target.type() === 'service_worker' && target.url().startsWith(extensionUrl),
    { timeout: 20_000 },
  );
  const worker = await workerTarget.worker();
  assert.ok(worker, 'Extension service worker must start');
  process.stdout.write(`Loaded ${report.browser}, extension ${extensionId}\n`);

  await worker.evaluate(() => {
    globalThis.__jevHarness = {
      scenario: 'proceed',
      navCalls: 0,
      plannerCalls: 0,
      actionCalls: 0,
      completionCalls: 0,
      selectionCalls: 0,
      selectedCalls: 0,
      requests: [],
    };
    globalThis.fetch = async (input, init) => {
      const state = globalThis.__jevHarness;
      const url = typeof input === 'string' ? input : input.url || String(input);
      const raw = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      let body;
      try {
        body = JSON.parse(String(raw));
      } catch {
        body = {};
      }
      const json = data =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        const answers = {};
        for (const [id, question] of Object.entries(body.questions)) {
          if (question.type === 'noul') {
            answers[id] = { type: 'noul', noul: 0 };
            continue;
          }
          const options = Object.keys(question.criteria);
          let choice = options[0];
          if (id === 'action') {
            state.actionCalls++;
            choice =
              state.scenario === 'reconsider'
                ? 'reconsider'
                : state.scenario.startsWith('confirm')
                  ? 'confirm'
                  : 'proceed';
          }
          if (id === 'completion') {
            state.completionCalls++;
            choice = ['completion_gate', 'confirm_expired'].includes(state.scenario)
              ? 'needs_verification'
              : 'complete';
          }
          if (id === 'route') choice = state.scenario.replace('routing_', '');
          if (id === 'selection') {
            state.selectionCalls++;
            choice =
              state.scenario === 'system1_select' && state.selectionCalls === 1
                ? options.find(value => value.startsWith('click_')) || '__fallback__'
                : '__fallback__';
            if (choice !== '__fallback__') state.selectedCalls++;
          }
          const remainder = 0.01 / (options.length - 1);
          answers[id] = {
            type: 'choice',
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 0.99 : remainder])),
          };
        }
        state.requests.push({ service: 'jev', operation: Object.keys(body.questions).join(','), model: body.model });
        return json({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 10 } });
      }
      if (url.includes('/chat/completions')) {
        const name = body.response_format?.json_schema?.name || '';
        let output;
        if (name.includes('planner')) {
          state.plannerCalls++;
          output = {
            observation: 'Synthetic local page',
            challenges: '',
            done:
              state.scenario === 'completion_gate' ||
              state.navCalls >= 2 ||
              (state.selectedCalls > 0 && state.navCalls > 0),
            next_steps: 'Click Mark complete then verify the result.',
            final_answer: 'Local fixture completed.',
            reasoning: 'Fixture verification',
            web_task: true,
          };
        } else {
          state.navCalls++;
          let index = 0;
          const text = JSON.stringify(body.messages);
          const match = text.match(/(?:\\n|\n)(\d+)\[:\]<button[^]*?Mark complete/);
          if (match) index = Number(match[1]);
          const mustClick = (state.navCalls === 1 && !state.selectedCalls) || state.scenario === 'reconsider';
          output = {
            current_state: {
              evaluation_previous_goal: 'Continue fixture task',
              memory: '',
              next_goal: mustClick ? 'Click the button' : 'Complete the task',
            },
            action: mustClick ? [{ click_element: { index } }] : [{ done: { text: 'COMPLETED', success: true } }],
          };
        }
        state.requests.push({ service: 'llm', operation: name, model: body.model });
        return json({
          id: 'fixture-completion',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });
      }
      // No unrecognized request is allowed to reach an external server (including analytics).
      state.requests.push({ service: 'blocked', operation: new URL(url).pathname });
      return new Response('{}', { status: 503 });
    };
  });
  const settings = {
    enabled: true,
    apiKey: 'offline-fixture-key',
    model: 'jev-latest',
    timeoutMs: 10_000,
    proceedThreshold: 0.8,
    completionThreshold: 0.9,
    selectionThreshold: 0.8,
    routingEnabled: false,
    system1Enabled: false,
  };
  await worker.evaluate(
    async (config, baseUrl) => {
      await chrome.storage.local.set({
        'analytics-settings': { enabled: false, anonymousUserId: 'isolated-fixture' },
        'jev-settings': config,
        'llm-api-keys': {
          providers: {
            fixture: {
              name: 'Offline fixture',
              type: 'custom_openai',
              apiKey: 'offline-llm-key',
              baseUrl,
              modelNames: ['fixture-model', 'fixture-fast', 'fixture-capable'],
            },
          },
        },
        'agent-models': {
          agents: {
            navigator: { provider: 'fixture', modelName: 'fixture-model' },
            planner: { provider: 'fixture', modelName: 'fixture-model' },
          },
        },
        'general-settings': {
          maxSteps: 10,
          maxActionsPerStep: 1,
          maxFailures: 3,
          useVision: false,
          useVisionForPlanner: false,
          planningInterval: 50,
          displayHighlights: false,
          minWaitPageLoad: 250,
          replayHistoricalTasks: false,
        },
      });
    },
    settings,
    fixtureUrl.replace('/fixture', '/v1'),
  );

  await test('extension service worker and settings save/reload', async () => {
    const options = await browser.newPage();
    await options.goto(`${extensionUrl}/${manifest.options_ui.page}`);
    await options.locator('nav li:nth-child(3) button').click();
    await options.waitForSelector('#jev-api-key:enabled');
    await options.locator('#jev-api-key').fill('offline-ui-key');
    await options.locator('#jev-timeoutMs').fill('12000');
    await options.locator('fieldset button').click();
    await options.waitForFunction(() =>
      document.body.textContent.includes(chrome.i18n.getMessage('options_jev_saved')),
    );
    await options.reload();
    await options.locator('nav li:nth-child(3) button').click();
    await options.waitForSelector('#jev-api-key:enabled');
    assert.equal(await options.$eval('#jev-api-key', element => element.value), 'offline-ui-key');
    assert.equal(await options.$eval('#jev-timeoutMs', element => element.value), '12000');
    await options.close();
    return { extensionId, storagePersisted: true };
  });

  const page = await browser.newPage();
  await page.goto(fixtureUrl);
  const sidePanel = await browser.newPage();
  await sidePanel.evaluateOnNewDocument(() => {
    window.__events = [];
    window.__sent = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (...args) => {
      const port = connect(...args);
      const postMessage = port.postMessage.bind(port);
      port.postMessage = message => {
        window.__sent.push(message);
        postMessage(message);
      };
      port.onMessage.addListener(message => window.__events.push(message));
      window.__fixturePort = port;
      return port;
    };
  });
  diagnostics = async () => ({
    harness: await worker.evaluate(() => globalThis.__jevHarness),
    events: await sidePanel.evaluate(() => window.__events),
    sentTypes: await sidePanel.evaluate(() =>
      window.__sent?.map(message => ({ type: message.type, tabId: message.tabId })),
    ),
  });

  async function begin(scenario, enabled = true) {
    await page.goto(fixtureUrl);
    await worker.evaluate(
      async (scenarioName, config) => {
        globalThis.__jevHarness = {
          scenario: scenarioName,
          navCalls: 0,
          plannerCalls: 0,
          actionCalls: 0,
          completionCalls: 0,
          selectionCalls: 0,
          selectedCalls: 0,
          requests: [],
        };
        await chrome.storage.local.set({ 'jev-settings': config });
      },
      scenario,
      {
        ...settings,
        enabled,
        routingEnabled: scenario.startsWith('routing_'),
        system1Enabled: scenario.startsWith('system1_'),
        fastModel: { provider: 'fixture', modelName: 'fixture-fast' },
        capableModel: { provider: 'fixture', modelName: 'fixture-capable' },
      },
    );
    await sidePanel.bringToFront();
    await sidePanel.goto(`${extensionUrl}/${manifest.side_panel.default_path}`);
    await sidePanel.waitForSelector('textarea:enabled');
    await sidePanel.locator('textarea').fill(`Offline fixture ${scenario}: click Mark complete and verify COMPLETED.`);
    await page.bringToFront();
    await sidePanel.keyboard.press('Enter');
    await sidePanel.waitForFunction(() => window.__events.some(event => event.state === 'task.start'), {
      polling: 100,
    });
  }
  async function event(state) {
    await sidePanel.waitForFunction(
      stateName => window.__events.some(value => value.state === stateName || value.state === 'task.fail'),
      { timeout: 30_000, polling: 100 },
      state,
    );
    const failed = await sidePanel.evaluate(() => window.__events.find(value => value.state === 'task.fail'));
    if (failed) throw new Error(failed.data.details);
  }
  async function clicks() {
    return page.evaluate(() => window.clicks);
  }
  async function metrics() {
    return worker.evaluate(() => ({
      navigatorCalls: __jevHarness.navCalls,
      plannerCalls: __jevHarness.plannerCalls,
      actionEvaluations: __jevHarness.actionCalls,
      completionEvaluations: __jevHarness.completionCalls,
      selectionEvaluations: __jevHarness.selectionCalls,
      mockedRequests: __jevHarness.requests,
    }));
  }
  async function cancel() {
    await sidePanel.evaluate(() => window.__fixturePort.postMessage({ type: 'cancel_task' }));
    await event('task.cancel');
    await sidePanel.waitForFunction(() => !document.querySelector('[role="alert"]'), { polling: 100 });
  }

  await test('Jev disabled preserves Navigator execution', async () => {
    await begin('disabled', false);
    await event('task.ok');
    assert.equal(await clicks(), 1);
    const data = await metrics();
    assert.equal(data.actionEvaluations + data.completionEvaluations, 0);
    return data;
  });
  await test('proceed executes click and verifies completion', async () => {
    await begin('proceed');
    await event('task.ok');
    assert.equal(await clicks(), 1);
    const data = await metrics();
    assert.ok(data.actionEvaluations >= 1 && data.completionEvaluations >= 1);
    return data;
  });
  await test('reconsider prevents clicks and pauses after bounded retries', async () => {
    await begin('reconsider');
    await event('task.pause');
    assert.equal(await clicks(), 0);
    const data = await metrics();
    assert.equal(data.actionEvaluations, 2);
    await cancel();
    return data;
  });
  await test('confirm waits for explicit approval before executing', async () => {
    await begin('confirm_approve');
    await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'jev_confirmation'), {
      polling: 100,
    });
    assert.equal(await clicks(), 0);
    await sidePanel.evaluate(() => window.__fixturePort.postMessage({ type: 'resume_task' }));
    await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'success'), { polling: 100 });
    assert.equal(await clicks(), 0, 'Ordinary resume must not approve a pending action');
    await sidePanel.bringToFront();
    await sidePanel.locator('[role="alert"] button:first-of-type').click();
    await event('task.ok');
    assert.equal(await clicks(), 1);
    return metrics();
  });
  await test('reject prevents execution and exposes pause controls', async () => {
    await begin('confirm_reject');
    await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'jev_confirmation'), {
      polling: 100,
    });
    await sidePanel.bringToFront();
    await sidePanel.locator('[role="alert"] button:nth-of-type(2)').click();
    await event('task.pause');
    assert.equal(await clicks(), 0);
    assert.ok(await sidePanel.locator('[role="status"] button').waitHandle());
    const data = await metrics();
    await cancel();
    return data;
  });
  await test('cancelling pending approval clears it without executing', async () => {
    await begin('confirm_cancel');
    await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'jev_confirmation'), {
      polling: 100,
    });
    await cancel();
    assert.equal(await clicks(), 0);
    return metrics();
  });
  await test('completion gate refreshes once then pauses unverified claim', async () => {
    await begin('completion_gate');
    await event('task.pause');
    assert.equal(await clicks(), 0);
    assert.equal(await sidePanel.evaluate(() => window.__events.some(value => value.state === 'task.ok')), false);
    const data = await metrics();
    assert.equal(data.completionEvaluations, 2);
    await cancel();
    return data;
  });
  if (phase2) {
    await test('state change expires user approval without a click', async () => {
      await begin('confirm_expired');
      await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'jev_confirmation'), {
        polling: 100,
      });
      await page.evaluate(() => {
        document.getElementById('status').textContent = 'CHANGED';
      });
      await sidePanel.bringToFront();
      await sidePanel.locator('[role="alert"] button:first-of-type').click();
      await event('task.pause');
      assert.equal(await clicks(), 0);
      const data = await metrics();
      await cancel();
      return data;
    });
    await test('resume after rejection regenerates an action and clears pause controls', async () => {
      await begin('confirm_reject');
      await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'jev_confirmation'), {
        polling: 100,
      });
      await sidePanel.bringToFront();
      await sidePanel.locator('[role="alert"] button:nth-of-type(2)').click();
      await event('task.pause');
      assert.equal(await clicks(), 0);
      await worker.evaluate(() => {
        __jevHarness.scenario = 'proceed';
        __jevHarness.navCalls = 0;
      });
      await sidePanel.locator('[role="status"] button').click();
      await event('task.resume');
      await sidePanel.waitForFunction(() => !document.querySelector('[role="status"] button'), { polling: 100 });
      await event('task.ok');
      assert.equal(await clicks(), 1);
      return metrics();
    });
    for (const route of ['fast', 'capable', 'planner']) {
      await test(`routing selects ${route} execution strategy`, async () => {
        await begin(`routing_${route}`);
        await event('task.ok');
        assert.equal(await clicks(), 1);
        const data = await metrics();
        assert.equal(data.mockedRequests.filter(request => request.operation === 'route').length, 1);
        const navigator = data.mockedRequests.find(request => request.operation === 'navigator_output');
        assert.equal(navigator.model, route === 'planner' ? 'fixture-model' : `fixture-${route}`);
        assert.ok(data.plannerCalls > 0);
        return data;
      });
    }
    await test('routing confirmation prevents browser actions until approval', async () => {
      await begin('routing_confirm');
      await sidePanel.waitForFunction(() => window.__events.some(value => value.type === 'jev_confirmation'), {
        polling: 100,
      });
      assert.equal(await clicks(), 0);
      assert.equal((await metrics()).navigatorCalls, 0);
      await sidePanel.bringToFront();
      await sidePanel.locator('[role="alert"] button:first-of-type').click();
      await event('task.ok');
      assert.equal(await clicks(), 1);
      return metrics();
    });
  }
  if (allPhases) {
    await test('System-1 chooses bounded action then falls back for completion', async () => {
      await begin('system1_select');
      await event('task.ok');
      assert.equal(await clicks(), 1);
      const data = await metrics();
      assert.ok(data.selectionEvaluations >= 2);
      const selection = data.mockedRequests.findIndex(request => request.operation === 'selection');
      const navigator = data.mockedRequests.findIndex(request => request.operation === 'navigator_output');
      assert.ok(selection >= 0 && navigator > selection);
      assert.equal(data.actionEvaluations, 1);
      return data;
    });
    await test('System-1 fallback preserves generative Navigator path', async () => {
      await begin('system1_fallback');
      await event('task.ok');
      assert.equal(await clicks(), 1);
      const data = await metrics();
      assert.ok(data.selectionEvaluations >= 2 && data.navigatorCalls >= 2);
      return data;
    });
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Browser verification report: ${reportPath}\n`);
  await browser?.close();
  await new Promise(resolveServer => server.close(resolveServer));
}
