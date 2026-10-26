// One-click sign-in: a request, your answer in a dialog (a stand-in here), and the limits around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignIn, browserName, dialogText, macDialogArgs, systemAsk, type Answer } from '../server/signin';

/** A dialog you answer by hand (`answer('allow')`), seeing what it was asked. */
function dialog() {
  const asked: { code: string; browser: string }[] = [];
  let answer: (a: Answer) => void = () => {};
  const ask = (r: { code: string; browser: string }) => { asked.push(r); return new Promise<Answer>((done) => { answer = done; }); };
  return { asked, ask, answer: (a: Answer) => answer(a) };
}

test('allowed: the requester gets "allow" once; the dialog shows the page\'s code', async () => {
  const d = dialog(), s = new SignIn(d.ask);
  const r = s.start('Chrome on macOS');
  assert.ok(!('error' in r));
  assert.match(r.code, /^\d{4}$/);
  assert.deepEqual(d.asked, [{ code: r.code, browser: 'Chrome on macOS' }]);
  const waiting = s.wait(r.id, r.secret);
  d.answer('allow');
  assert.equal(await waiting, 'allow');
  assert.equal(await s.wait(r.id, r.secret), 'gone', 'used once');
});

test('not allowed, no answer, or a wrong secret: no sign-in', async () => {
  const d = dialog(), s = new SignIn(d.ask);
  const r = s.start('Firefox') as { id: string; code: string; secret: string };
  assert.equal(await s.wait(r.id, 'x'.repeat(r.secret.length)), 'deny', 'someone else can\'t collect it');
  assert.equal(await s.wait(r.id, 'short'), 'deny');
  assert.equal(await s.wait('nope', r.secret), 'gone');
  const waiting = s.wait(r.id, r.secret);
  d.answer('deny');
  assert.equal(await waiting, 'deny');
  const failing = new SignIn(() => Promise.reject(new Error('no GUI')));
  const f = failing.start('Safari') as { id: string; secret: string };
  assert.equal(await failing.wait(f.id, f.secret), 'deny', 'a dialog that fails is a no');
});

test('one at a time, three a minute, none where there is no dialog', async () => {
  let t = 1_000_000;
  const d = dialog(), s = new SignIn(d.ask, () => t);
  const a = s.start('Chrome') as { id: string; secret: string };
  assert.deepEqual(s.start('Chrome'), { error: 'busy' });
  d.answer('deny'); await s.wait(a.id, a.secret);
  for (let i = 0; i < 2; i++) { const r = s.start('Chrome') as any; d.answer('deny'); await s.wait(r.id, r.secret); }
  assert.deepEqual(s.start('Chrome'), { error: 'too-many' });
  t += 61_000;
  assert.ok(!('error' in s.start('Chrome')), 'fine again a minute later');
  assert.deepEqual(new SignIn(undefined).start('Chrome'), { error: 'unsupported' });
  assert.equal(systemAsk('linux'), undefined);
});

test('the dialog says which browser and the code, and macOS gets the text as an argument', () => {
  const text = dialogText('0421', 'Edge on Windows');
  assert.match(text, /Edge on Windows/);
  assert.match(text, /Code: 0421/);
  const args = macDialogArgs('say "hi" & `rm -rf`');
  assert.equal(args.at(-1), 'say "hi" & `rm -rf`');
  assert.ok(args.slice(0, -1).every((a) => !a.includes('rm -rf')), 'the text is never in the script');
  assert.match(args.join(' '), /default button 1 cancel button 1/, '"Don’t allow" is the default');
  assert.equal(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'Chrome on macOS');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
  assert.equal(browserName(undefined), 'a browser');
});

test('Windows asks with its own dialog, the text as a variable', async () => {
  const runs: [string, Record<string, string>, number | undefined][] = [];
  const ask = systemAsk('win32', async (script, env, ms) => { runs.push([script, env, ms]); return true; })!;
  assert.equal(await ask({ code: '1234', browser: 'Chrome on Windows' }), 'allow');
  assert.match(runs[0][0], /MessageBox/);
  assert.match(runs[0][1].AV_TEXT, /Code: 1234/);
  assert.equal(runs[0][2], 65_000, 'waits for your answer, then gives up');
});
